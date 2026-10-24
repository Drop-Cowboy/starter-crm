/**
 * Shared Redis plumbing for the redis store, fan-out, rate limiter and BullMQ queue.
 *
 * Where it sits: every provider that talks to Redis (or Valkey, its BSD-licensed
 * fork) reads the address and opens its client through here, so they agree on the
 * environment variable, the TLS rule and the key names.
 *
 * `DC_REDIS_URL` names the server, falling back to the `REDIS_URL` that Upstash and
 * most hosts set. In production the URL must be `rediss://` (TLS) unless Redis is
 * on localhost. The password inside the URL is redacted from every log line.
 * Redis 6.2 or newer, or Valkey.
 *
 * CONTRACT.md: "Providers" (store, fanout, ratelimit, webhooks).
 * What a customer changes: nothing.
 */

import { problem } from './problems.js';
import { allowsPlaintext } from './tls.js';
import { siteKey } from './providers/store/common.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Reads the Redis address.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {string|null} `DC_REDIS_URL`, else `REDIS_URL`, else null.
 */
export function redisUrl(env) {
    for (const key of ['DC_REDIS_URL', 'REDIS_URL']) {
        if (typeof env[key] === 'string' && env[key].trim() !== '') return env[key].trim();
    }
    return null;
}

/**
 * Checks that a Redis address is present, well formed and, in production, TLS.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @param {string} needs What needs it, for the message, such as `DC_STORE=redis`.
 * @returns {object[]} Boot problems (none when the address is fine).
 */
export function validateRedis(env, needs) {
    const raw = redisUrl(env);
    if (!raw) {
        return [problem('missing_redis_url', needs + ' needs DC_REDIS_URL.',
            'Set DC_REDIS_URL to your Redis or Valkey address, for example rediss://default:password@host:6379.')];
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        return [problem('invalid_redis_url', 'DC_REDIS_URL is not a URL.', 'Use an address such as redis://localhost:6379 or rediss://host:6379.')];
    }
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
        return [problem('invalid_redis_url', 'DC_REDIS_URL must start with redis:// or rediss://.', 'Use an address such as redis://localhost:6379 or rediss://host:6379.')];
    }
    const cluster = String(env.DC_REDIS_CLUSTER || '').trim().toLowerCase();
    if (cluster !== '' && !['on', 'off', '1', '0', 'true', 'false'].includes(cluster)) {
        return [problem('invalid_redis_cluster', 'DC_REDIS_CLUSTER must be on or off (got "' + env.DC_REDIS_CLUSTER + '").',
            'Set DC_REDIS_CLUSTER=on for a cluster-enabled Redis or Valkey such as ElastiCache Serverless, or leave it unset.')];
    }
    if (env.DC_ENV === 'production' && url.protocol !== 'rediss:' && !LOCAL_HOSTS.includes(url.hostname) && !allowsPlaintext(env)) {
        return [problem('insecure_redis_url', 'DC_REDIS_URL must use TLS (rediss://) in production.',
            'Use rediss:// with your provider\'s TLS endpoint. Localhost is exempt, and so is a private network you control when DC_INSECURE_PRIVATE_SERVICES=on.')];
    }
    return [];
}

/**
 * The prefix for every key the redis store writes: one hash tag per site, so a
 * cluster keeps one site's keys together and a script can touch several at once.
 *
 * @param {{ siteId?: string|null }} config The loaded config.
 * @returns {string} For example `starter-crm:{3f8a2c1e-...}:`.
 */
export function keyPrefix(config) {
    return 'starter-crm:{' + siteKey(config) + '}:';
}

/**
 * The BullMQ prefix. BullMQ names its keys `<prefix>:<queue>:...`; the braces are
 * the hash tag, so every key of one site's queue lives on one cluster slot, and one
 * site's queue never mixes with another's. The Python server builds the same string.
 *
 * @param {{ siteId?: string|null }} config The loaded config.
 * @returns {string} For example `{starter-crm-3f8a2c1e-...}`.
 */
export function bullmqPrefix(config) {
    return '{starter-crm-' + siteKey(config) + '}';
}

/** The BullMQ queue name every server uses, so a Node and a Python server share one queue. */
export const QUEUE_NAME = 'webhooks';

/**
 * Whether Redis runs in cluster mode (`DC_REDIS_CLUSTER=on`). ElastiCache Serverless and any cluster-enabled
 * Valkey or Redis needs it: the client then treats `DC_REDIS_URL` as one seed node, finds the rest, and follows
 * MOVED redirects. Every key this starter writes carries one hash tag per site, so scripts that touch several keys
 * keep working on a cluster.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {boolean} True for `on`, `1` or `true`.
 */
export function redisCluster(env) {
    return ['on', '1', 'true'].includes(String(env.DC_REDIS_CLUSTER || '').trim().toLowerCase());
}

/**
 * Opens a Redis client and waits until it is connected.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment (`DC_REDIS_URL`, `DC_REDIS_CLUSTER`).
 * @param {{ forQueue?: boolean }} [options] `forQueue` turns off the per-request retry
 *   limit, which BullMQ's blocking commands need.
 * @returns {Promise<import('ioredis').Redis|import('ioredis').Cluster>} A connected client.
 * @throws {Error} When the server cannot be reached.
 */
export async function connectRedis(env, options = {}) {
    // The client is only needed when a Redis-backed provider is chosen, so it is not imported at the top of the file.
    const { Redis, Cluster } = await import('ioredis');
    const url = redisUrl(env);
    const redisOptions = {
        maxRetriesPerRequest: options.forQueue ? null : 2,
        enableReadyCheck: true,
        connectTimeout: 5000
    };
    let client;
    if (redisCluster(env)) {
        const seed = new URL(url);
        client = new Cluster([{ host: seed.hostname.replace(/^\[|\]$/g, ''), port: Number(seed.port) || 6379 }], {
            lazyConnect: true,
            // A cluster node announces its own address, so the seed's TLS and credentials are repeated for every node.
            redisOptions: Object.assign({
                username: decodeURIComponent(seed.username) || undefined,
                password: decodeURIComponent(seed.password) || undefined,
                tls: seed.protocol === 'rediss:' ? {} : undefined
            }, redisOptions),
            dnsLookup: (address, callback) => callback(null, address),
            clusterRetryStrategy: (times) => Math.min(times * 200, 2000),
            slotsRefreshTimeout: 5000
        });
    } else {
        client = new Redis(url, Object.assign({ lazyConnect: true }, redisOptions));
    }
    // An unhandled 'error' event would crash the process, and the client reconnects on its own. The listener
    // only remembers the message: an event callback cannot await a log call, and the awaited operations
    // that fail (and /readyz, through ready()) report the outage where it can be handled.
    client.on('error', (err) => {
        client.lastError = err.message;
    });
    await client.connect();
    return client;
}
