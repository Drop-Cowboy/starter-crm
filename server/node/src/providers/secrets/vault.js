/**
 * The `vault` secrets provider: HashiCorp Vault or OpenBao, KV version 2.
 *
 * Where it sits: `DC_SECRETS=vault`. One KV v2 secret (a path under a mount)
 * holds one field per starter secret: `DROPCOWBOY_API_KEY`, and so on. The
 * provider reads that secret's current version and keeps only the names the
 * starter asks for. REST over `fetch`; there is no SDK, and OpenBao answers the
 * same API, so one provider serves both.
 *
 * Authentication is one of:
 * - a token (`VAULT_TOKEN`), which the provider uses as is, or
 * - AppRole (`VAULT_ROLE_ID` and `VAULT_SECRET_ID`), which the provider logs
 *   in with, then logs in again before the token's lease runs out or when
 *   Vault answers 403 to a call.
 * The token, or the role id and secret id, is the bootstrap credential and
 * comes from the host's environment.
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: VAULT_ADDR and VAULT_PATH (required); VAULT_TOKEN, or VAULT_ROLE_ID with
 *   VAULT_SECRET_ID; VAULT_MOUNT (default secret), VAULT_APPROLE_MOUNT (default
 *   approle), VAULT_NAMESPACE (Vault Enterprise and HCP).
 * What a customer changes: nothing.
 */

import { problem } from '../../problems.js';
import { pick, requestJson, validateBaseUrl } from './http.js';

export const name = 'vault';
export const configKeys = ['VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_ROLE_ID', 'VAULT_SECRET_ID', 'VAULT_PATH', 'VAULT_MOUNT', 'VAULT_APPROLE_MOUNT', 'VAULT_NAMESPACE'];

/** Log in again when this share of an AppRole token's lease has passed. */
const LEASE_SHARE = 0.8;

/**
 * Checks the address, the secret's path and exactly one way to authenticate.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = [];
    const set = (key) => typeof env[key] === 'string' && env[key].trim() !== '';
    if (!set('VAULT_ADDR')) {
        problems.push(problem('missing_vault_setting', 'DC_SECRETS=vault needs VAULT_ADDR.', 'Set VAULT_ADDR to your Vault or OpenBao address, for example https://vault.example.com:8200.'));
    } else {
        const bad = validateBaseUrl('VAULT_ADDR', env.VAULT_ADDR.trim());
        if (bad) problems.push(bad);
    }
    if (!set('VAULT_PATH')) {
        problems.push(problem('missing_vault_setting', 'DC_SECRETS=vault needs VAULT_PATH.', 'Set VAULT_PATH to the KV v2 secret that holds the starter\'s secrets, for example starter-crm.'));
    } else if (env.VAULT_PATH.split('/').includes('..')) {
        problems.push(problem('invalid_vault_path', 'VAULT_PATH must not contain "..".', 'Set VAULT_PATH to a plain path such as starter-crm or apps/starter-crm.'));
    }
    const token = set('VAULT_TOKEN');
    const role = set('VAULT_ROLE_ID') || set('VAULT_SECRET_ID');
    if (token && role) {
        problems.push(problem('invalid_vault_auth', 'VAULT_TOKEN and VAULT_ROLE_ID / VAULT_SECRET_ID are both set.', 'Use one: a token, or AppRole. Remove the other.'));
    } else if (!token && !role) {
        problems.push(problem('missing_vault_setting', 'DC_SECRETS=vault needs VAULT_TOKEN, or VAULT_ROLE_ID with VAULT_SECRET_ID.', 'Set VAULT_TOKEN, or set both VAULT_ROLE_ID and VAULT_SECRET_ID for AppRole.'));
    } else if (role && !(set('VAULT_ROLE_ID') && set('VAULT_SECRET_ID'))) {
        problems.push(problem('missing_vault_setting', 'AppRole needs both VAULT_ROLE_ID and VAULT_SECRET_ID.', 'Set both, or use VAULT_TOKEN instead.'));
    }
    return problems;
}

/**
 * Turns a mount or path setting into URL path segments, each encoded, with no empty ones.
 *
 * @param {string} value Such as "apps/starter-crm/".
 * @returns {string} Such as "apps/starter-crm".
 */
function segments(value) {
    return value.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * Creates the provider.
 *
 * @param {{ env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, now?: () => number }} ctx Provider context;
 *   `fetchImpl` and `now` are replaced in tests.
 * @returns {{ load: (names: string[]) => Promise<Record<string, string>>, refresh: () => Promise<Record<string, string>> }}
 *   The instance.
 */
export function create(ctx) {
    const env = ctx.env;
    const base = env.VAULT_ADDR.trim().replace(/\/+$/, '');
    const mount = segments((env.VAULT_MOUNT || '').trim() || 'secret');
    const approleMount = segments((env.VAULT_APPROLE_MOUNT || '').trim() || 'approle');
    const secretPath = segments(env.VAULT_PATH.trim());
    const namespace = (env.VAULT_NAMESPACE || '').trim();
    const now = ctx.now || Date.now;
    const staticToken = (env.VAULT_TOKEN || '').trim();
    let lastNames = [];
    let session = staticToken ? { token: staticToken, expiresAt: Infinity } : null;

    function headers() {
        const out = { 'X-Vault-Token': session.token };
        if (namespace) out['X-Vault-Namespace'] = namespace;
        return out;
    }

    async function login() {
        const { body } = await requestJson('Vault', base + '/v1/auth/' + approleMount + '/login', {
            method: 'POST',
            headers: namespace ? { 'X-Vault-Namespace': namespace } : {},
            body: { role_id: env.VAULT_ROLE_ID.trim(), secret_id: env.VAULT_SECRET_ID.trim() },
            fetchImpl: ctx.fetchImpl
        });
        const auth = body && body.auth;
        if (!auth || typeof auth.client_token !== 'string' || auth.client_token === '') {
            throw new Error('Vault AppRole login did not return a token');
        }
        const lease = Number.isFinite(auth.lease_duration) && auth.lease_duration > 0 ? auth.lease_duration : 0;
        session = { token: auth.client_token, expiresAt: lease > 0 ? now() + lease * 1000 * LEASE_SHARE : now() };
    }

    async function fetchSecret() {
        try {
            return await requestJson('Vault', base + '/v1/' + mount + '/data/' + secretPath, { headers: headers(), fetchImpl: ctx.fetchImpl });
        } catch (err) {
            // Name the mount and path, which are settings and not secrets, so a typo is easy to see.
            if (err.status === 404) throw new Error('Vault has no KV v2 secret at ' + mount + '/' + secretPath, { cause: err });
            throw err;
        }
    }

    async function read(names) {
        if (!session || now() >= session.expiresAt) await login();
        let result;
        try {
            result = await fetchSecret();
        } catch (err) {
            // An AppRole token can be revoked early; one fresh login, then give up. A static token cannot be renewed here.
            if (err.status !== 403 || staticToken) throw err;
            await login();
            result = await fetchSecret();
        }
        const data = result.body && result.body.data && result.body.data.data;
        return pick(data && typeof data === 'object' ? data : {}, names);
    }

    return {
        async load(names) {
            lastNames = names;
            return read(names);
        },
        async refresh() {
            return read(lastNames);
        }
    };
}
