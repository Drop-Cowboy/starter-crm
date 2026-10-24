/**
 * The `1password` secrets provider: reads fields of one 1Password item, or one
 * item per secret, with a service account and the official SDK.
 *
 * Where it sits: `DC_SECRETS=1password`. The provider signs in with a service
 * account token (`OP_SERVICE_ACCOUNT_TOKEN`) and resolves secret references
 * for the names the starter asks for:
 *
 * - With `OP_ITEM` set, one item holds a field per secret and the reference is
 *   `op://<vault>/<item>/<NAME>`. Create a field called `DROPCOWBOY_API_KEY`
 *   and so on in that item.
 * - Without `OP_ITEM`, each secret is its own item, named like the variable,
 *   and the value is read from its `credential` field:
 *   `op://<vault>/<NAME>/credential`.
 * A name with no matching field is simply left out, like any provider. If none
 * of the names can be read at all, the provider fails, since that points at a
 * wrong vault, item or token and not at an optional secret.
 *
 * The SDK is `@1password/sdk`, pinned in package.json and imported only here,
 * only when this provider is selected, so the other providers never load it.
 * The token is the bootstrap credential and comes from the host's environment.
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: OP_SERVICE_ACCOUNT_TOKEN and OP_VAULT (required), OP_ITEM (optional).
 * What a customer changes: nothing.
 */

import { problem } from '../../problems.js';

export const name = '1password';
export const configKeys = ['OP_SERVICE_ACCOUNT_TOKEN', 'OP_VAULT', 'OP_ITEM'];

const INTEGRATION_NAME = 'Drop Cowboy Starter CRM';
const INTEGRATION_VERSION = '1.0.0';

/**
 * Checks the token and the vault are set, and that the names are usable in a reference.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = [];
    const set = (key) => typeof env[key] === 'string' && env[key].trim() !== '';
    if (!set('OP_SERVICE_ACCOUNT_TOKEN')) {
        problems.push(problem('missing_onepassword_setting', 'DC_SECRETS=1password needs OP_SERVICE_ACCOUNT_TOKEN.',
            'Create a service account with read access to one vault and set OP_SERVICE_ACCOUNT_TOKEN to its token in the host\'s environment.'));
    }
    if (!set('OP_VAULT')) {
        problems.push(problem('missing_onepassword_setting', 'DC_SECRETS=1password needs OP_VAULT.',
            'Set OP_VAULT to the name or id of the vault that holds the secrets.'));
    }
    for (const key of ['OP_VAULT', 'OP_ITEM']) {
        // A slash or a query character would change which reference is resolved.
        if (set(key) && /[/?#]/.test(env[key])) {
            problems.push(problem('invalid_onepassword_setting', key + ' must not contain /, ? or #.', 'Use the plain name or id of the ' + (key === 'OP_VAULT' ? 'vault' : 'item') + '.'));
        }
    }
    return problems;
}

/**
 * Creates the provider.
 *
 * @param {{ env: NodeJS.ProcessEnv, sdk?: { createClient: Function } }} ctx Provider context; `sdk` replaces the
 *   real package in tests.
 * @returns {Promise<{ load: (names: string[]) => Promise<Record<string, string>>, refresh: () => Promise<Record<string, string>> }>}
 *   The instance.
 */
export async function create(ctx) {
    // Imported here and not at the top so the SDK (and its WebAssembly core) is only loaded when `DC_SECRETS=1password` is chosen.
    const sdk = ctx.sdk || await import('@1password/sdk');
    const vault = ctx.env.OP_VAULT.trim();
    const item = (ctx.env.OP_ITEM || '').trim();
    let client = null;
    let lastNames = [];

    function reference(secretName) {
        return item ? 'op://' + vault + '/' + item + '/' + secretName : 'op://' + vault + '/' + secretName + '/credential';
    }

    async function read(names) {
        if (!client) {
            client = await sdk.createClient({
                auth: ctx.env.OP_SERVICE_ACCOUNT_TOKEN.trim(),
                integrationName: INTEGRATION_NAME,
                integrationVersion: INTEGRATION_VERSION
            });
        }
        // Each name is resolved on its own, so one missing field does not hide the others.
        const results = await Promise.all(names.map(async (secretName) => {
            try {
                return { secretName, value: await client.secrets.resolve(reference(secretName)) };
            } catch (err) {
                return { secretName, error: err };
            }
        }));
        const values = {};
        for (const result of results) {
            if (typeof result.value === 'string' && result.value !== '') values[result.secretName] = result.value;
        }
        const failed = results.find((result) => result.error);
        if (names.length > 0 && Object.keys(values).length === 0 && failed) {
            const detail = failed.error && failed.error.message ? failed.error.message : 'unknown error';
            throw new Error('1Password could not read any secret from vault "' + vault + '"' + (item ? ', item "' + item + '"' : '') + ': ' + detail);
        }
        return values;
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
