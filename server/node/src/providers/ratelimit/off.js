/**
 * The `off` rate limiter: lets everything through.
 *
 * Where it sits: `DC_RATE_LIMIT=off`. Use it when a gateway in front of the
 * server already limits traffic, or in tests that fire many requests.
 *
 * CONTRACT.md: "Rate limits".
 * What a customer changes: nothing.
 */

export const name = 'off';
export const configKeys = [];

/** Tells the provider conformance check that this limiter allows everything on purpose. */
export const neverLimits = true;

/**
 * Nothing to configure.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the limiter.
 *
 * @returns {{ hit: Function }} A limiter that always allows.
 */
export function create() {
    return {
        async hit(key, limit) {
            return { allowed: true, remaining: limit, retryAfterSeconds: 1 };
        }
    };
}
