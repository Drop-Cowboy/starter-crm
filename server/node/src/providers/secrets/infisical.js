/**
 * The `infisical` secrets provider: reads one environment of an Infisical
 * project with a machine identity (universal auth).
 *
 * Where it sits: `DC_SECRETS=infisical`. It works against Infisical Cloud or
 * your own Infisical (`INFISICAL_URL`). The provider signs in with the machine
 * identity's client id and secret, receives a short-lived access token, reads
 * the secrets of one project environment and folder, and keeps only the names
 * the starter asks for. It signs in again when the token expires, or when
 * Infisical answers 401 to a call. REST over `fetch`; there is no SDK.
 *
 * Client id and secret are the bootstrap credential and come from the host's
 * environment. Everything else comes from Infisical.
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID (all required),
 *   INFISICAL_ENVIRONMENT (default prod), INFISICAL_SECRET_PATH (default /),
 *   INFISICAL_URL (default https://app.infisical.com).
 * What a customer changes: nothing.
 */

import { problem } from '../../problems.js';
import { pick, requestJson, validateBaseUrl } from './http.js';

export const name = 'infisical';
export const configKeys = ['INFISICAL_CLIENT_ID', 'INFISICAL_CLIENT_SECRET', 'INFISICAL_PROJECT_ID', 'INFISICAL_ENVIRONMENT', 'INFISICAL_SECRET_PATH', 'INFISICAL_URL'];

const DEFAULT_URL = 'https://app.infisical.com';
/** Sign in again this long before the token's stated expiry, so a call never carries a token about to lapse. */
const EXPIRY_MARGIN_MS = 30000;

/**
 * Checks the identity, the project and the address.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = [];
    const set = (key) => typeof env[key] === 'string' && env[key].trim() !== '';
    for (const [key, fix] of [
        ['INFISICAL_CLIENT_ID', 'Create a machine identity with universal auth and set INFISICAL_CLIENT_ID to its client id.'],
        ['INFISICAL_CLIENT_SECRET', 'Set INFISICAL_CLIENT_SECRET to a client secret of that machine identity, in the host\'s environment.'],
        ['INFISICAL_PROJECT_ID', 'Set INFISICAL_PROJECT_ID to the id of the project that holds the secrets.']
    ]) {
        if (!set(key)) problems.push(problem('missing_infisical_setting', 'DC_SECRETS=infisical needs ' + key + '.', fix));
    }
    if (set('INFISICAL_URL')) {
        const bad = validateBaseUrl('INFISICAL_URL', env.INFISICAL_URL.trim());
        if (bad) problems.push(bad);
    }
    return problems;
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
    const base = ((env.INFISICAL_URL || '').trim() || DEFAULT_URL).replace(/\/+$/, '');
    const now = ctx.now || Date.now;
    let lastNames = [];
    let session = null;

    async function signIn() {
        const { body } = await requestJson('Infisical', base + '/api/v1/auth/universal-auth/login', {
            method: 'POST',
            body: { clientId: env.INFISICAL_CLIENT_ID.trim(), clientSecret: env.INFISICAL_CLIENT_SECRET.trim() },
            fetchImpl: ctx.fetchImpl
        });
        if (!body || typeof body.accessToken !== 'string' || body.accessToken === '') {
            throw new Error('Infisical sign-in did not return an access token');
        }
        const seconds = Number.isFinite(body.expiresIn) ? body.expiresIn : 0;
        session = { token: body.accessToken, expiresAt: now() + seconds * 1000 - EXPIRY_MARGIN_MS };
    }

    async function fetchSecrets() {
        const query = new URLSearchParams({
            workspaceId: env.INFISICAL_PROJECT_ID.trim(),
            environment: (env.INFISICAL_ENVIRONMENT || '').trim() || 'prod',
            secretPath: (env.INFISICAL_SECRET_PATH || '').trim() || '/',
            expandSecretReferences: 'true'
        });
        return requestJson('Infisical', base + '/api/v3/secrets/raw?' + query.toString(), {
            headers: { Authorization: 'Bearer ' + session.token },
            fetchImpl: ctx.fetchImpl
        });
    }

    async function read(names) {
        if (!session || now() >= session.expiresAt) await signIn();
        let result;
        try {
            result = await fetchSecrets();
        } catch (err) {
            // The token can be revoked before it expires; one fresh sign-in, then give up.
            if (err.status !== 401) throw err;
            await signIn();
            result = await fetchSecrets();
        }
        const all = {};
        const list = result.body && Array.isArray(result.body.secrets) ? result.body.secrets : [];
        for (const item of list) {
            if (item && typeof item.secretKey === 'string' && typeof item.secretValue === 'string') all[item.secretKey] = item.secretValue;
        }
        return pick(all, names);
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
