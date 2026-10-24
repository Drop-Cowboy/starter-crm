// Redis in cluster mode (DC_REDIS_CLUSTER=on) against the single-node Valkey cluster in tests/services.compose.yml.
// The store has its own cluster cases in stores.test.js; these cover the fan-out, the rate limiter and the BullMQ
// webhook mode. The suites skip, with a notice, when the cluster is not running.
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as bullmq from '../src/providers/webhooks/bullmq.js';
import * as fanout from '../src/providers/fanout/redis.js';
import * as ratelimit from '../src/providers/ratelimit/redis.js';
import { connectRedis, redisCluster, validateRedis } from '../src/redis.js';
import { HAVE_REDIS_CLUSTER, REDIS_CLUSTER_URL, freshSite } from './services.js';

const env = { DC_REDIS_URL: REDIS_CLUSTER_URL, DC_REDIS_CLUSTER: 'on' };
const log = { warn: async () => {}, error: async () => {}, info: async () => {} };
const opened = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return true;
        await wait(50);
    }
    return false;
}

afterEach(async () => {
    while (opened.length) await opened.pop()();
});

describe.skipIf(!HAVE_REDIS_CLUSTER)('redis cluster', () => {
    it('connects as a cluster client', async () => {
        const client = await connectRedis(env);
        opened.push(() => client.quit());
        expect(client.isCluster).toBe(true);
        expect(await client.ping()).toBe('PONG');
    });

    it('delivers a published event id to a subscriber, through the cluster', async () => {
        const store = { get: async (id) => ({ event_id: id, event: 'contact.msg.received', event_at: 1, received_at: 2, attempt: 1, data: {}, status: 'processed' }) };
        const ctx = { config: { siteId: freshSite() }, env, store, log };
        const first = await fanout.create(ctx);
        const second = await fanout.create(ctx);
        opened.push(() => first.close(), () => second.close());
        const seen = [];
        second.subscribe((event) => seen.push(event.event_id));
        const id = crypto.randomUUID();
        await first.publish({ event_id: id });
        expect(await until(() => seen.includes(id))).toBe(true);
        expect(await second.ready()).toBe(true);
    });

    it('counts hits in the rate limiter and refuses past the limit', async () => {
        const limiter = await ratelimit.create({ config: { siteId: freshSite() }, env, log });
        opened.push(() => limiter.close());
        const key = crypto.randomUUID();
        const outcomes = [];
        for (let i = 0; i < 4; i++) outcomes.push((await limiter.hit(key, 3, 60)).allowed);
        expect(outcomes).toEqual([true, true, true, false]);
    });

    it('queues an event id in BullMQ and runs the handler through the cluster', async () => {
        const seen = [];
        const dispatcher = await bullmq.create({
            config: { siteId: freshSite(), events: { workerInProcess: true, maxAttempts: 3 } },
            env, store: {}, log,
            processor: { process: async (id) => { seen.push(id); return { outcome: 'processed' }; } }
        });
        opened.push(() => dispatcher.stop());
        await dispatcher.start();
        const id = crypto.randomUUID();
        expect(await dispatcher.dispatch(id)).toEqual({ outcome: 'queued' });
        expect(await until(() => seen.includes(id))).toBe(true);
        expect(await dispatcher.ready()).toBe(true);
    });

    it('retries a failing handler through the cluster queue', async () => {
        const calls = [];
        const dispatcher = await bullmq.create({
            config: { siteId: freshSite(), events: { workerInProcess: true, maxAttempts: 3 } },
            env, store: {}, log,
            processor: { process: async (id) => { calls.push(id); return calls.length === 1 ? { outcome: 'retry', error: 'down' } : { outcome: 'processed' }; } }
        });
        opened.push(() => dispatcher.stop());
        await dispatcher.start();
        await dispatcher.dispatch(crypto.randomUUID());
        expect(await until(() => calls.length === 2, 10000)).toBe(true);
    });
});

describe('redis cluster settings', () => {
    it('reads on, 1 and true as cluster mode, and anything else as off', () => {
        for (const value of ['on', 'ON', '1', 'true']) expect(redisCluster({ DC_REDIS_CLUSTER: value })).toBe(true);
        for (const value of [undefined, '', 'off', '0', 'false']) expect(redisCluster({ DC_REDIS_CLUSTER: value })).toBe(false);
    });

    it('rejects a value that is not on or off', () => {
        const base = { DC_REDIS_URL: 'redis://localhost:6379' };
        expect(validateRedis({ ...base, DC_REDIS_CLUSTER: 'maybe' }, 'x').map((p) => p.code)).toEqual(['invalid_redis_cluster']);
        expect(validateRedis({ ...base, DC_REDIS_CLUSTER: 'on' }, 'x')).toEqual([]);
    });
});
