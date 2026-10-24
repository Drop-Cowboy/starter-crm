/**
 * The `dev` identity: everyone is the user in `STARTER_CRM_USER_ID`.
 *
 * Where it sits: the default for local development. It is deliberately
 * unsafe, because it lets every request through as one fixed user, so boot
 * refuses it when `DC_ENV=production`. Use `passcode`, `oidc` or your own
 * provider for anything other people can reach.
 *
 * CONTRACT.md: "Boot" (`production_dev_identity`) and "Identity routes".
 * What a customer changes: nothing; switch `DC_IDENTITY` instead.
 */

export const name = 'dev';
export const configKeys = ['STARTER_CRM_USER_ID'];

/** Tells the provider conformance check that this identity signs everyone in on purpose. */
export const alwaysSignedIn = true;

/**
 * Nothing to check here: the config loader requires the user id.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the identity.
 *
 * @param {{ config: { starterUserId: string|null } }} ctx Provider context.
 * @returns {{ authenticate: Function }} An identity that always signs in the placeholder user.
 */
export function create(ctx) {
    return {
        async authenticate() {
            return { id: ctx.config.starterUserId };
        }
    };
}
