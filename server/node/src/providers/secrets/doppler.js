/**
 * The `doppler` secrets provider: reads one Doppler config with a service token.
 *
 * Where it sits: `DC_SECRETS=doppler`. A Doppler service token belongs to one
 * project and one config (for example `starter-crm` / `prd`), so the token
 * alone says what to read. The provider downloads that config's secrets and
 * keeps only the names the starter asks for. It uses Doppler's REST API over
 * `fetch`; there is no SDK to install.
 *
 * The token is the one credential that must come from the host's environment
 * (`DOPPLER_TOKEN`), since nothing can be loaded without it. Everything else
 * comes from Doppler, and a rotated value is picked up every
 * `DC_SECRETS_REFRESH_SECONDS` without a restart.
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: DOPPLER_TOKEN (required), DOPPLER_API_URL (default https://api.doppler.com).
 * What a customer changes: nothing.
 */

import { problem } from '../../problems.js';
import { pick, requestJson, validateBaseUrl } from './http.js';

export const name = 'doppler';
export const configKeys = ['DOPPLER_TOKEN', 'DOPPLER_API_URL'];

const DEFAULT_URL = 'https://api.doppler.com';

/**
 * Checks the token is set and the API address is safe.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = [];
    if (!(typeof env.DOPPLER_TOKEN === 'string' && env.DOPPLER_TOKEN.trim())) {
        problems.push(problem('missing_doppler_token', 'DC_SECRETS=doppler needs DOPPLER_TOKEN.',
            'Create a service token for one Doppler config and put it in the host\'s environment under that name.'));
    }
    if (typeof env.DOPPLER_API_URL === 'string' && env.DOPPLER_API_URL.trim()) {
        const bad = validateBaseUrl('DOPPLER_API_URL', env.DOPPLER_API_URL.trim());
        if (bad) problems.push(bad);
    }
    return problems;
}

/**
 * Creates the provider.
 *
 * @param {{ env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} ctx Provider context; `fetchImpl` replaces `fetch` in tests.
 * @returns {{ load: (names: string[]) => Promise<Record<string, string>>, refresh: () => Promise<Record<string, string>> }}
 *   The instance.
 */
export function create(ctx) {
    const token = ctx.env.DOPPLER_TOKEN.trim();
    const base = ((ctx.env.DOPPLER_API_URL || '').trim() || DEFAULT_URL).replace(/\/+$/, '');
    let lastNames = [];

    async function read(names) {
        const { body } = await requestJson('Doppler', base + '/v3/configs/config/secrets/download?format=json', {
            headers: { Authorization: 'Bearer ' + token },
            fetchImpl: ctx.fetchImpl
        });
        return pick(body && typeof body === 'object' ? body : {}, names);
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
