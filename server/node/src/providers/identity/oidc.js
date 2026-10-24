/**
 * The `oidc` identity: verifies a bearer JWT from an OpenID Connect issuer.
 *
 * Where it sits: for apps whose users already sign in somewhere else (Auth0,
 * Clerk, Supabase, Firebase, Okta, Keycloak). The browser sends
 * `Authorization: Bearer <JWT>` and this verifies the signature against the
 * issuer's published keys, then maps the token to a user. Nothing is stored.
 *
 * What is checked, and why:
 * - Only RS256 and ES256. Refusing everything else, `none` and the HS*
 *   family included, is what stops algorithm-confusion attacks.
 * - `iss` and `aud` must match exactly, and `exp` must exist, with 60 seconds
 *   of clock skew.
 * - Keys come from `DC_OIDC_JWKS_URL`, or from the issuer's discovery
 *   document. They are cached, and an unknown key id triggers a refetch at
 *   most every 2 seconds, so made-up key ids cannot make this server hammer
 *   the issuer.
 *
 * The user id is the token's `sub` when that is a UUID, else
 * `UUIDv5(DROPCOWBOY_SITE_ID, issuer + "|" + sub)`: Drop Cowboy needs a UUID,
 * and v5 is stateless and the same on every server.
 *
 * CONTRACT.md: "The `oidc` identity".
 * Env: DC_OIDC_ISSUER (https; plain http only for a loopback host),
 * DC_OIDC_AUDIENCE, DC_OIDC_JWKS_URL (optional), DROPCOWBOY_SITE_ID.
 * What a customer changes: nothing; see CUSTOMIZE.md for per-vendor settings.
 */

import { HttpError } from '../../errors.js';
import { problem } from '../../problems.js';
import { UUID_PATTERN, uuidv5 } from '../../uuid.js';

export const name = 'oidc';
export const configKeys = ['DC_OIDC_ISSUER', 'DC_OIDC_AUDIENCE', 'DC_OIDC_JWKS_URL'];

/** Clock skew accepted on `exp` and `nbf`: 60 seconds covers ordinary drift between servers. */
const CLOCK_TOLERANCE_SECONDS = 60;

/** Minimum gap between key-set refetches triggered by an unknown key id. */
const JWKS_COOLDOWN_MS = 2000;

/** How long fetched keys are trusted before a refetch even for a known key id: ten minutes. */
const JWKS_MAX_AGE_MS = 10 * 60 * 1000;

/** How long to wait for the issuer before reporting it unavailable. */
const ISSUER_TIMEOUT_MS = 5000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const BEARER = /^Bearer +([^ ]+) *$/i;

/**
 * Checks the `DC_OIDC_*` settings.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const issuer = typeof env.DC_OIDC_ISSUER === 'string' ? env.DC_OIDC_ISSUER.trim() : '';
    const audience = typeof env.DC_OIDC_AUDIENCE === 'string' ? env.DC_OIDC_AUDIENCE.trim() : '';
    const jwks = typeof env.DC_OIDC_JWKS_URL === 'string' ? env.DC_OIDC_JWKS_URL.trim() : '';
    const problems = [];

    if (!issuer) {
        problems.push(problem('missing_oidc_issuer', 'DC_IDENTITY=oidc needs DC_OIDC_ISSUER.',
            'Set DC_OIDC_ISSUER to your identity provider\'s issuer URL, such as https://example.us.auth0.com/.'));
    } else {
        let parsed = null;
        try {
            parsed = new URL(issuer);
        } catch {
            // Reported below.
        }
        const secure = parsed && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)));
        if (!secure) {
            problems.push(problem('invalid_oidc_issuer', 'DC_OIDC_ISSUER must be an https URL (plain http is only allowed for localhost).',
                'Use the https issuer URL from your identity provider.'));
        }
    }
    if (!audience) {
        problems.push(problem('missing_oidc_audience', 'DC_IDENTITY=oidc needs DC_OIDC_AUDIENCE.',
            'Set DC_OIDC_AUDIENCE to the audience (API identifier or client id) your tokens are issued for.'));
    }
    if (jwks && !/^https?:\/\/[^/]+/.test(jwks)) {
        problems.push(problem('invalid_oidc_jwks_url', 'DC_OIDC_JWKS_URL must be an http(s) URL.',
            'Set DC_OIDC_JWKS_URL to the issuer\'s key set URL, or leave it empty to use discovery.'));
    }
    return problems;
}

/**
 * Whether a jose error means the token is bad, as opposed to the issuer being unreachable.
 *
 * @param {unknown} err What jose threw.
 * @returns {boolean} True for a token problem.
 */
function isTokenError(err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    return typeof code === 'string' && /^ERR_(JWT_|JWS_|JWE_|JWK_|JOSE_ALG|JOSE_NOT_SUPPORTED|JWKS_NO_MATCHING_KEY|JWKS_MULTIPLE)/.test(code);
}

/**
 * Creates the identity. Imports `jose` here, not at the top of the file, so a
 * server that does not use oidc never loads it.
 *
 * @param {{ config: object, fetch?: typeof fetch }} ctx Provider context.
 * @returns {Promise<object>} The instance.
 */
export async function create(ctx) {
    // Imported only when oidc is selected: jose is the one dependency this provider needs.
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    const { issuer, audience, jwksUrl } = ctx.config.oidc;
    const siteId = ctx.config.siteId;
    const fetchImpl = ctx.fetch || globalThis.fetch;
    let keys = null;

    /**
     * Finds the key set, discovering its URL on first use.
     *
     * @returns {Promise<Function>} A jose key resolver.
     * @throws {HttpError} 503 `identity_unavailable` when discovery fails.
     */
    async function keySet() {
        if (keys) return keys;
        let uri = jwksUrl;
        if (!uri) {
            try {
                const response = await fetchImpl(issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration', {
                    signal: AbortSignal.timeout(ISSUER_TIMEOUT_MS),
                    redirect: 'error'
                });
                const document = response.ok ? await response.json() : null;
                uri = document && typeof document.jwks_uri === 'string' ? document.jwks_uri : null;
            } catch {
                uri = null;
            }
            if (!uri) {
                throw new HttpError(503, 'identity_unavailable', 'The sign-in provider could not be reached. Try again shortly.');
            }
        }
        keys = createRemoteJWKSet(new URL(uri), {
            cooldownDuration: JWKS_COOLDOWN_MS,
            cacheMaxAge: JWKS_MAX_AGE_MS,
            timeoutDuration: ISSUER_TIMEOUT_MS
        });
        return keys;
    }

    const challenge = (error) => ({ 'www-authenticate': 'Bearer' + (error ? ' error="' + error + '"' : '') });

    return {
        challenge: 'Bearer',
        async authenticate(request) {
            const match = BEARER.exec(request.headers.get('authorization') || '');
            if (!match) return null;
            const resolver = await keySet();
            let payload;
            try {
                ({ payload } = await jwtVerify(match[1], resolver, {
                    issuer,
                    audience,
                    algorithms: ['RS256', 'ES256'],
                    clockTolerance: CLOCK_TOLERANCE_SECONDS,
                    requiredClaims: ['exp']
                }));
            } catch (err) {
                if (isTokenError(err)) {
                    throw new HttpError(401, 'invalid_token', 'The sign-in token is not valid. Sign in again.', challenge('invalid_token'));
                }
                throw new HttpError(503, 'identity_unavailable', 'The sign-in provider could not be reached. Try again shortly.');
            }
            if (typeof payload.sub !== 'string' || payload.sub === '') {
                throw new HttpError(401, 'invalid_token', 'The sign-in token has no subject.', challenge('invalid_token'));
            }
            const user = { id: UUID_PATTERN.test(payload.sub) ? payload.sub.toLowerCase() : uuidv5(siteId, issuer + '|' + payload.sub) };
            if (typeof payload.email === 'string') user.email = payload.email;
            if (typeof payload.name === 'string') user.name = payload.name;
            return user;
        }
    };
}
