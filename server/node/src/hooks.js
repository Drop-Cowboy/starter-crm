/**
 * Observer hooks: lets your own code watch requests, errors, webhooks and
 * token mints without touching the routes.
 *
 * Where it sits: the core creates one `hooks` object from the observer
 * provider (`DC_OBSERVER`) and calls it at the five points below. Hooks are
 * awaited, because a hook still running when a serverless host freezes the
 * process would be lost, and a hook that throws is logged and ignored so
 * monitoring can never break a request.
 *
 * CONTRACT.md: "Observer hooks".
 * What a customer changes: nothing; write an observer provider instead.
 */

/** The hook names, in the order a request meets them. */
export const HOOK_NAMES = ['onRequest', 'onResponse', 'onError', 'onWebhook', 'onTokenMinted'];

/**
 * Wraps an observer so every hook is safe to call.
 *
 * @param {object|null} observer The observer instance, or null for none.
 * @param {{ warn: Function }} log Where a failing hook is reported.
 * @returns {Record<string, (payload: object) => Promise<void>>} One async function per hook.
 */
export function createHooks(observer, log) {
    const hooks = {};
    for (const hook of HOOK_NAMES) {
        hooks[hook] = async (payload) => {
            if (!observer || typeof observer[hook] !== 'function') return;
            try {
                await observer[hook](payload);
            } catch (err) {
                await log.warn('Observer hook ' + hook + ' failed: ' + (err && err.message ? err.message : 'unknown error'));
            }
        };
    }
    return hooks;
}
