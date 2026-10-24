/**
 * The `memory` rate limiter: fixed one-minute windows counted in this process.
 *
 * Where it sits: the core asks `hit()` before the token route, the passcode
 * sign-in and the dev session. Counts are per instance, which is right for
 * one or two long-running instances. On serverless hosts every instance
 * counts alone, so limits barely bite; the shared `redis` limiter (a later
 * phase) is for those. A fixed window is deliberately simple and matches what
 * the Redis limiter will do.
 *
 * CONTRACT.md: "Rate limits".
 * What a customer changes: nothing; to share counts across instances, set
 * `DC_RATE_LIMIT` to a provider that does.
 */

/** Past this many keys, expired windows are swept on the next hit, so a flood of distinct keys cannot grow memory without bound. */
const SWEEP_AT = 10000;

/** The hard cap: beyond it the oldest windows are dropped, accepting a briefly reset counter over an out-of-memory crash. */
const MAX_KEYS = 100000;

export const name = 'memory';
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
 * Creates a limiter.
 *
 * @param {{ now?: () => number }} [ctx] Provider context; `now` is for tests.
 * @returns {{ hit: (key: string, limit: number, windowSeconds: number) => Promise<{ allowed: boolean, remaining: number, retryAfterSeconds: number }> }}
 *   The limiter instance.
 */
export function create(ctx = {}) {
    const now = ctx.now || Date.now;
    const windows = new Map();

    function sweep(at) {
        for (const [key, entry] of windows) {
            if (entry.resetAt <= at) windows.delete(key);
        }
        // Map iterates in insertion order, so the first keys are the oldest.
        for (const key of windows.keys()) {
            if (windows.size <= MAX_KEYS) break;
            windows.delete(key);
        }
    }

    return {
        async hit(key, limit, windowSeconds) {
            const at = now();
            if (windows.size >= SWEEP_AT) sweep(at);
            let entry = windows.get(key);
            if (!entry || entry.resetAt <= at) {
                entry = { count: 0, resetAt: at + windowSeconds * 1000 };
                windows.set(key, entry);
            }
            entry.count++;
            return {
                allowed: entry.count <= limit,
                remaining: Math.max(0, limit - entry.count),
                retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - at) / 1000))
            };
        }
    };
}
