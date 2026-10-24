/**
 * The `passcode` identity: one shared passcode unlocks the app.
 *
 * Where it sits: the default for one-click deploys. Someone who knows
 * `DC_PASSCODE` signs in once and gets a signed, HttpOnly session cookie
 * lasting 12 hours; every protected route then treats them as one owner. It
 * is a gate, not an account system: swap in `oidc` or your own provider when
 * you need separate users.
 *
 * The cookie is `base64url(JSON {v, sub, iat, exp}).base64url(HMAC-SHA256)`.
 * The HMAC key is derived from the passcode and site id, so changing the
 * passcode signs everyone out and no separate session secret is needed. There
 * is no server-side session list, so signing out only clears the cookie.
 * Rotate the passcode to revoke every session at once.
 *
 * CONTRACT.md: "Identity routes", "CSRF".
 * Env: DC_PASSCODE (at least 12 characters), DROPCOWBOY_SITE_ID,
 * STARTER_CRM_USER_ID (optional: names the one owner), DC_ENV.
 * What a customer changes: nothing.
 */

import crypto from 'node:crypto';
import { HttpError } from '../../errors.js';
import { checkOrigin } from '../../security.js';
import { jsonResponse, readJsonBody } from '../../http.js';
import { problem } from '../../problems.js';
import { uuidv5 } from '../../uuid.js';

export const name = 'passcode';
export const configKeys = ['DC_PASSCODE'];

/** The shortest passcode accepted: below 12 characters a guesser's 10-a-minute budget still adds up. */
const MIN_PASSCODE_LENGTH = 12;

/** How long a session lasts: 12 hours, a working day, then sign in again. */
const SESSION_SECONDS = 12 * 60 * 60;

/** Sign-in attempts per client IP per minute. */
const SIGN_IN_LIMIT = 10;

/** Cookie format version, so a future change can reject old cookies cleanly. */
const COOKIE_VERSION = 1;

/**
 * Checks `DC_PASSCODE`.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems; none of them contain the passcode.
 */
export function validate(env) {
    const passcode = typeof env.DC_PASSCODE === 'string' ? env.DC_PASSCODE.trim() : '';
    if (!passcode) {
        return [problem('missing_passcode', 'DC_IDENTITY=passcode needs DC_PASSCODE.',
            'Set DC_PASSCODE to a passcode of at least ' + MIN_PASSCODE_LENGTH + ' characters.')];
    }
    if (passcode.length < MIN_PASSCODE_LENGTH) {
        return [problem('weak_passcode', 'DC_PASSCODE must be at least ' + MIN_PASSCODE_LENGTH + ' characters.',
            'Use a longer passcode, for example three random words.')];
    }
    return [];
}

/**
 * Reads one cookie out of a `Cookie` header.
 *
 * @param {string|null} header The raw header.
 * @param {string} cookieName The cookie to find.
 * @returns {string|null} Its value, or null.
 */
function readCookie(header, cookieName) {
    if (!header) return null;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index > 0 && part.slice(0, index).trim() === cookieName) return part.slice(index + 1).trim();
    }
    return null;
}

/**
 * Compares two strings without leaking where they differ.
 *
 * Both sides are hashed first so the comparison always sees equal lengths.
 *
 * @param {string} a One string.
 * @param {string} b The other.
 * @returns {boolean} True when equal.
 */
function constantTimeEqual(a, b) {
    const left = crypto.createHash('sha256').update(a).digest();
    const right = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(left, right);
}

/**
 * Creates the identity.
 *
 * @param {{ config: object }} ctx Provider context.
 * @returns {object} The instance: `authenticate`, `routes`, plus `cookieAuth` so the core adds CSRF checks.
 */
export function create(ctx) {
    const { config } = ctx;
    const production = config.env === 'production';
    // `__Host-` makes browsers refuse a cookie that is not Secure, has a Domain, or a Path other than /.
    const cookieName = (production ? '__Host-' : '') + 'starter_crm_session';
    const key = crypto.createHash('sha256').update('starter-crm-session|' + config.siteId + '|' + config.passcode).digest();
    const ownerId = config.starterUserId || uuidv5(config.siteId, 'passcode|owner');

    const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

    function cookieHeader(value, maxAge) {
        const parts = [cookieName + '=' + value, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=' + maxAge];
        if (production) parts.push('Secure');
        return parts.join('; ');
    }

    /**
     * Reads and verifies the session cookie.
     *
     * @param {Request} request The incoming request.
     * @returns {{ id: string }|null} The user, or null for no cookie or a bad one.
     */
    function userFrom(request) {
        const raw = readCookie(request.headers.get('cookie'), cookieName);
        const dot = raw ? raw.indexOf('.') : -1;
        if (dot < 1) return null;
        const payload = raw.slice(0, dot);
        const mac = Buffer.from(raw.slice(dot + 1), 'base64url');
        const expected = Buffer.from(sign(payload), 'base64url');
        if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
        try {
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            const now = Math.floor(Date.now() / 1000);
            const valid = claims && claims.v === COOKIE_VERSION && typeof claims.sub === 'string' && claims.sub !== ''
                && claims.sub.length <= 200 && Number.isInteger(claims.exp) && claims.exp > now;
            return valid ? { id: claims.sub } : null;
        } catch {
            return null;
        }
    }

    /**
     * The checks every cookie-changing POST here shares: a trusted origin, then JSON.
     *
     * @param {object} requestCtx The request context.
     * @returns {void}
     * @throws {HttpError} 403 `csrf_rejected` or 415 `unsupported_media_type`.
     */
    function guard(requestCtx) {
        checkOrigin(requestCtx);
        if (!/^application\/json\b/i.test(requestCtx.request.headers.get('content-type') || '')) {
            throw new HttpError(415, 'unsupported_media_type', 'Send this request as application/json.');
        }
    }

    return {
        cookieAuth: true,
        async authenticate(request) {
            return userFrom(request);
        },
        routes() {
            return [
                {
                    method: 'POST',
                    path: '/api/auth/passcode',
                    async handler(requestCtx) {
                        guard(requestCtx);
                        await requestCtx.limit('passcode', requestCtx.clientIp, SIGN_IN_LIMIT);
                        const body = await readJsonBody(requestCtx.request);
                        const given = body && typeof body === 'object' && typeof body.passcode === 'string' ? body.passcode : '';
                        if (!given || !constantTimeEqual(given, config.passcode)) {
                            throw new HttpError(401, 'invalid_passcode', 'That passcode is not right.');
                        }
                        const iat = Math.floor(Date.now() / 1000);
                        const payload = Buffer.from(JSON.stringify({ v: COOKIE_VERSION, sub: ownerId, iat, exp: iat + SESSION_SECONDS }))
                            .toString('base64url');
                        const response = jsonResponse(200, { signed_in: true }, { 'cache-control': 'no-store' });
                        response.headers.append('set-cookie', cookieHeader(payload + '.' + sign(payload), SESSION_SECONDS));
                        return response;
                    }
                },
                {
                    method: 'POST',
                    path: '/api/auth/signout',
                    async handler(requestCtx) {
                        guard(requestCtx);
                        const response = jsonResponse(200, { signed_in: false }, { 'cache-control': 'no-store' });
                        response.headers.append('set-cookie', cookieHeader('', 0));
                        return response;
                    }
                }
            ];
        }
    };
}
