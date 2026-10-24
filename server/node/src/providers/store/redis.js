/**
 * The `redis` event store: events in Redis (or Valkey) with persistence on.
 *
 * Where it sits: `DC_STORE=redis`, with `DC_REDIS_URL`. It suits hosts whose
 * only datastore is Redis, such as Upstash on Vercel or Netlify. Each event is a
 * hash; sorted sets index the received events (by when the outbox may take
 * them), the finished ones (by when they finished, which orders replay) and the
 * failed ones. Recording is one atomic script, so two instances racing on the
 * same event id insert it once.
 *
 * The server must keep its data: turn on AOF or snapshots (Upstash and
 * ElastiCache do) and use `maxmemory-policy noeviction`, or Redis may drop
 * events it was holding. Finished events expire on their own after
 * `DC_EVENT_RETENTION_HOURS`. Module data does not live in Redis; it needs
 * owner-filtered queries and backups, which a SQL database does better.
 *
 * CONTRACT.md: "Event store".
 * Env: DC_REDIS_URL (or REDIS_URL). What a customer changes: nothing.
 */

import { connectRedis, keyPrefix, validateRedis } from '../../redis.js';
import { DEFAULT_LEASE_MS, REPLAY_OVERLAP_MS, STATUSES, contactIdOf, publicEvent, replayLimit, retentionMs } from './common.js';

export const name = 'redis';
export const configKeys = ['DC_REDIS_URL', 'REDIS_URL', 'DC_REDIS_CLUSTER'];

/**
 * Checks the Redis address.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    return validateRedis(env, 'DC_STORE=redis');
}

const RECORD = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {0, redis.call('HGET', KEYS[1], 'status')} end
redis.call('HSET', KEYS[1], 'json', ARGV[1], 'status', 'received', 'attempts', 0, 'next_attempt_at', ARGV[2], 'contact_id', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4])
if ARGV[3] ~= '' then redis.call('SADD', KEYS[3], ARGV[4]) end
return {1, 'received'}
`;

const FINISH = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'done_at', ARGV[3])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'last_error', ARGV[4]) end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
if ARGV[2] == 'failed' then redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1]) end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

const NOTE_FAILURE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
redis.call('HSET', KEYS[1], 'last_error', ARGV[2], 'next_attempt_at', ARGV[3])
if redis.call('HGET', KEYS[1], 'status') == 'received' then redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1]) end
return attempts
`;

const CLAIM = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, id in ipairs(ids) do redis.call('ZADD', KEYS[1], ARGV[3], id) end
return ids
`;

const REPLAY = `
if redis.call('HGET', KEYS[1], 'status') ~= 'failed' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'received', 'attempts', 0, 'next_attempt_at', ARGV[2])
redis.call('HDEL', KEYS[1], 'done_at')
redis.call('PERSIST', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`;

/**
 * Turns a stored hash into an event object.
 *
 * @param {Record<string, string>} hash The hash fields, as Redis returns them.
 * @returns {object|null} The event, or null when the hash is empty (the event expired or never existed).
 */
function fromHash(hash) {
    if (!hash || !hash.json) return null;
    const base = JSON.parse(hash.json);
    return {
        event_id: base.event_id,
        event: base.event,
        event_at: base.event_at,
        received_at: base.received_at,
        attempt: base.attempt,
        data: base.data,
        contact_id: hash.contact_id === '' ? null : hash.contact_id,
        status: hash.status,
        attempts: Number(hash.attempts),
        next_attempt_at: Number(hash.next_attempt_at),
        last_error: hash.last_error === undefined ? null : hash.last_error,
        done_at: hash.done_at === undefined ? null : Number(hash.done_at)
    };
}

/**
 * Connects and returns the store.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, now?: () => number, client?: object }} ctx Provider context; `now`
 *   and `client` are replaced in tests (a client passed in is not closed by the store).
 * @returns {Promise<object>} The store (see the interface in memory.js).
 */
export async function create(ctx) {
    const now = ctx.now || Date.now;
    const keepMs = retentionMs(ctx.config);
    const prefix = keyPrefix(ctx.config);
    const redis = ctx.client || await connectRedis(ctx.env);
    const key = {
        event: (id) => prefix + 'ev:' + id,
        pending: prefix + 'pending',
        done: prefix + 'done',
        failed: prefix + 'failed',
        contact: (id) => prefix + 'contact:' + id
    };

    /**
     * Reads several events by id.
     *
     * @param {string[]} ids The event ids.
     * @returns {Promise<(object|null)[]>} The events in the same order; null for any that no longer exist.
     */
    async function load(ids) {
        if (ids.length === 0) return [];
        const pipeline = redis.pipeline();
        for (const id of ids) pipeline.hgetall(key.event(id));
        const results = await pipeline.exec();
        return results.map(([err, hash]) => {
            if (err) throw err;
            return fromHash(hash);
        });
    }

    /**
     * Marks an event finished.
     *
     * @param {string} eventId The event.
     * @param {string} status `processed` or `failed`.
     * @param {string} error The error text, or an empty string.
     * @returns {Promise<void>}
     */
    async function finish(eventId, status, error) {
        await redis.eval(FINISH, 4, key.event(eventId), key.pending, key.done, key.failed, eventId, status, String(now()), error, String(keepMs));
    }

    return {
        async record(event, { visibleAt } = {}) {
            const contactId = contactIdOf(event.data) || '';
            const json = JSON.stringify(publicEvent(event));
            const [inserted, status] = await redis.eval(RECORD, 3, key.event(event.event_id), key.pending, key.contact(contactId),
                json, String(visibleAt ?? now()), contactId, event.event_id);
            return { inserted: inserted === 1, status: status || STATUSES.received };
        },

        async get(eventId) {
            return fromHash(await redis.hgetall(key.event(eventId)));
        },

        markProcessed(eventId) {
            return finish(eventId, STATUSES.processed, '');
        },

        markFailed(eventId, error) {
            return finish(eventId, STATUSES.failed, String(error) || 'failed');
        },

        async noteFailure(eventId, error, nextAttemptAt) {
            return Number(await redis.eval(NOTE_FAILURE, 2, key.event(eventId), key.pending, eventId, String(error), String(nextAttemptAt)));
        },

        async since({ afterEventId, limit } = {}) {
            const size = replayLimit(limit);
            let from = '-inf';
            if (afterEventId) {
                const score = await redis.zscore(key.done, afterEventId);
                if (score !== null) from = String(Number(score) - REPLAY_OVERLAP_MS);
            }
            // Newest first, one extra in case the cursor itself is in the window, then flipped to oldest first.
            const ids = (await redis.zrevrangebyscore(key.done, '+inf', from, 'LIMIT', 0, size + 1)).filter((id) => id !== afterEventId).slice(0, size);
            const events = (await load(ids)).filter(Boolean);
            return events.reverse().map(publicEvent);
        },

        async pending({ limit = 10, leaseMs = DEFAULT_LEASE_MS } = {}) {
            const at = now();
            const ids = await redis.eval(CLAIM, 1, key.pending, String(at), String(limit), String(at + leaseMs));
            return (await load(ids)).filter(Boolean);
        },

        async listFailed({ limit = 50 } = {}) {
            const ids = await redis.zrevrange(key.failed, 0, limit - 1);
            return (await load(ids)).filter(Boolean);
        },

        async replay(eventId) {
            return Number(await redis.eval(REPLAY, 4, key.event(eventId), key.pending, key.done, key.failed, eventId, String(now()))) === 1;
        },

        async purgeContact(contactId, keepEventId) {
            const ids = (await redis.smembers(key.contact(contactId))).filter((id) => id !== keepEventId);
            const pipeline = redis.pipeline();
            for (const id of ids) {
                pipeline.del(key.event(id));
                pipeline.zrem(key.pending, id);
                pipeline.zrem(key.done, id);
                pipeline.zrem(key.failed, id);
                pipeline.srem(key.contact(contactId), id);
            }
            if (keepEventId) {
                const kept = await redis.hget(key.event(keepEventId), 'json');
                if (kept) {
                    const base = JSON.parse(kept);
                    base.data = { contact_id: contactId };
                    pipeline.hset(key.event(keepEventId), 'json', JSON.stringify(base));
                }
            }
            await pipeline.exec();
            return ids.length;
        },

        async counts() {
            const [received, finished, failed] = await Promise.all([redis.zcard(key.pending), redis.zcard(key.done), redis.zcard(key.failed)]);
            const out = { received, processed: Math.max(0, finished - failed), failed, oldest_received_age_seconds: 0 };
            const oldest = await load(await redis.zrange(key.pending, 0, 19));
            let earliest = null;
            for (const row of oldest) {
                if (row && (earliest === null || row.received_at < earliest)) earliest = row.received_at;
            }
            if (earliest !== null) out.oldest_received_age_seconds = Math.max(0, Math.round((now() - earliest) / 1000));
            return out;
        },

        async prune() {
            const cutoff = String(now() - keepMs);
            // Failed events are in both sets, so the done count already includes them.
            const [done] = await Promise.all([redis.zremrangebyscore(key.done, '-inf', cutoff), redis.zremrangebyscore(key.failed, '-inf', cutoff)]);
            return Number(done);
        },

        async ready() {
            try {
                return (await redis.ping()) === 'PONG';
            } catch {
                return false;
            }
        },

        async close() {
            if (!ctx.client) await redis.quit();
        }
    };
}
