/**
 * The `redis` rate limiter: one-minute windows counted in Redis, so limits hold across every instance.
 *
 * Where it sits: `DC_RATE_LIMIT=redis`, the default whenever `DC_REDIS_URL` is set. The
 * same fixed-window rule as the memory limiter, kept atomic by one Lua script: `INCR`
 * the counter, and on the first hit of a window `PEXPIRE` it. Redis, not the
 * instance, decides who is over the limit, which is what makes it work on hosts where
 * every request may land on a different instance.
 *
 * If Redis cannot be reached the limiter lets the request through and logs a warning,
 * rather than turning a Redis outage into an outage of sign-in and the dialer's tokens.
 * That is a deliberate trade-off: the passcode and token limits protect against abuse,
 * not against data loss, and the store's own checks still apply.
 *
 * CONTRACT.md: "Rate limits".
 * Env: DC_REDIS_URL. What a customer changes: nothing.
 */

import { connectRedis, keyPrefix, validateRedis } from '../../redis.js';

export const name = 'redis';
export const configKeys = ['DC_REDIS_URL', 'REDIS_URL', 'DC_REDIS_CLUSTER'];

const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

/**
 * Checks the Redis address.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    return validateRedis(env, 'DC_RATE_LIMIT=redis');
}

/**
 * Connects and creates the limiter.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, log: object, client?: object }} ctx Provider context; a `client` passed in
 *   is used as is (tests).
 * @returns {Promise<{ hit: Function, close: Function }>} The limiter instance.
 */
export async function create(ctx) {
    const redis = ctx.client || await connectRedis(ctx.env);
    const prefix = keyPrefix(ctx.config) + 'rl:';
    return {
        async hit(key, limit, windowSeconds) {
            try {
                const [count, ttl] = await redis.eval(HIT, 1, prefix + key, String(windowSeconds * 1000));
                return {
                    allowed: count <= limit,
                    remaining: Math.max(0, limit - count),
                    retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000))
                };
            } catch (err) {
                await ctx.log.warn('The Redis rate limiter is unreachable, so this request was not counted:', err.message);
                return { allowed: true, remaining: limit, retryAfterSeconds: 1 };
            }
        },
        async close() {
            if (!ctx.client) await redis.quit();
        }
    };
}
