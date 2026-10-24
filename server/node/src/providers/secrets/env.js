/**
 * The `env` secrets provider: secrets are already environment variables.
 *
 * Where it sits: the default (`DC_SECRETS=env`). Vercel and Netlify
 * inject secrets as environment variables, and the ECS template can inject
 * them from Secrets Manager the same way, so there is nothing to load. Because
 * the variables are fixed at process start, a rotation needs a restart or a
 * redeploy.
 *
 * CONTRACT.md: "Providers" (secrets).
 * What a customer changes: nothing.
 */

export const name = 'env';
export const configKeys = [];

/**
 * Nothing to configure.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the provider.
 *
 * @returns {{ load: Function, refresh: Function }} An instance that adds nothing.
 */
export function create() {
    return {
        async load() {
            return {};
        },
        async refresh() {
            return {};
        }
    };
}
