// One suite, run against every built-in event store (memory, sqlite, and the
// real Postgres and Valkey from tests/services.compose.yml when they are up).
// A custom store should pass the same cases: they are the store contract.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as dynamodb from '../src/providers/store/dynamodb.js';
import * as memory from '../src/providers/store/memory.js';
import * as postgres from '../src/providers/store/postgres.js';
import * as redisStore from '../src/providers/store/redis.js';
import * as sqlite from '../src/providers/store/sqlite.js';
import { HAVE_DYNAMODB, HAVE_POSTGRES, HAVE_REDIS, HAVE_REDIS_CLUSTER, POSTGRES_URL, REDIS_CLUSTER_URL, REDIS_URL, awsTestEnv, freshSite } from './services.js';

const STARTER_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-store-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * Builds a store for one site.
 *
 * @param {object} options Which provider, which site and an injectable clock.
 * @returns {Promise<object>} The store.
 */
async function build({ provider, site, now, retentionHours = 72, file, env: more = {} }) {
    const config = {
        siteId: site,
        root: STARTER_ROOT,
        events: { retentionHours, sqlitePath: file || path.join(tmp, crypto.randomUUID() + '.sqlite') }
    };
    const env = awsTestEnv({ DC_DATABASE_URL: POSTGRES_URL, DC_REDIS_URL: REDIS_URL, ...more });
    return provider.create({ config, env, now, log: { warn() {} } });
}

function event(id, extra = {}) {
    return { event_id: id, event: 'contact.msg.received', event_at: 1, received_at: 2, attempt: 1, data: { contact_id: 'c-1', n: 1 }, ...extra };
}

const stores = [
    ['memory', memory, true],
    ['sqlite', sqlite, true],
    ['postgres', postgres, HAVE_POSTGRES],
    ['redis', redisStore, HAVE_REDIS],
    ['redis (cluster)', redisStore, HAVE_REDIS_CLUSTER, { DC_REDIS_URL: REDIS_CLUSTER_URL, DC_REDIS_CLUSTER: 'on' }],
    ['dynamodb', dynamodb, HAVE_DYNAMODB]
];

for (const [label, provider, available, providerEnv] of stores) {
    describe.skipIf(!available)('event store: ' + label, () => {
        const open = (extra = {}) => build({ provider, site: freshSite(), env: providerEnv, ...extra });

        it('records an event once and reports the status of a duplicate', async () => {
            const store = await open();
            const id = crypto.randomUUID();
            expect(await store.record(event(id))).toEqual({ inserted: true, status: 'received' });
            expect(await store.record(event(id))).toEqual({ inserted: false, status: 'received' });
            await store.markProcessed(id);
            expect(await store.record(event(id))).toEqual({ inserted: false, status: 'processed' });
            await store.close();
        });

        it('inserts once when many instances record the same id at the same moment', async () => {
            const store = await open();
            const id = crypto.randomUUID();
            const results = await Promise.all(Array.from({ length: 12 }, () => store.record(event(id))));
            expect(results.filter((r) => r.inserted)).toHaveLength(1);
            await store.close();
        });

        it('gets an event with its status, and null for an unknown one', async () => {
            const store = await open();
            const id = crypto.randomUUID();
            await store.record(event(id));
            const row = await store.get(id);
            expect(row).toMatchObject({ event_id: id, event: 'contact.msg.received', status: 'received', attempts: 0, data: { contact_id: 'c-1', n: 1 } });
            expect(await store.get(crypto.randomUUID())).toBeNull();
            await store.close();
        });

        it('replays only finished events, oldest first, from a cursor or from the latest', async () => {
            let clock = 1_000_000;
            const store = await open({ now: () => clock });
            const ids = [];
            for (let i = 0; i < 5; i++) {
                const id = crypto.randomUUID();
                ids.push(id);
                await store.record(event(id, { data: { n: i } }));
                clock += 10_000;
                await store.markProcessed(id);
            }
            const stillReceived = crypto.randomUUID();
            await store.record(event(stillReceived));
            const all = await store.since({});
            expect(all.map((e) => e.event_id)).toEqual(ids);
            expect(all[0]).toEqual({ event_id: ids[0], event: 'contact.msg.received', event_at: 1, received_at: 2, attempt: 1, data: { n: 0 } });
            // The cursor is excluded; events finished within 5 s before it are included (the overlap).
            const after = await store.since({ afterEventId: ids[2] });
            expect(after.map((e) => e.event_id)).toEqual([ids[3], ids[4]]);
            // An unknown cursor behaves like no cursor, and the limit keeps the latest.
            expect((await store.since({ afterEventId: crypto.randomUUID() })).map((e) => e.event_id)).toEqual(ids);
            expect((await store.since({ limit: 2 })).map((e) => e.event_id)).toEqual([ids[3], ids[4]]);
            await store.close();
        });

        it('overlaps a cursor by five seconds so events another instance finished a moment later are not lost', async () => {
            let clock = 5_000_000;
            const store = await open({ now: () => clock });
            const first = crypto.randomUUID();
            const second = crypto.randomUUID();
            await store.record(event(first));
            await store.record(event(second));
            clock += 100;
            await store.markProcessed(second);
            clock += 100;
            await store.markProcessed(first);
            // A browser whose last event was `first` still gets `second`, which finished 100 ms earlier.
            expect((await store.since({ afterEventId: first })).map((e) => e.event_id)).toEqual([second]);
            await store.close();
        });

        it('hands each due event to one claimant and leaves it alone until the lease ends', async () => {
            let clock = 2_000_000;
            const store = await open({ now: () => clock });
            const a = crypto.randomUUID();
            const later = crypto.randomUUID();
            await store.record(event(a));
            await store.record(event(later), { visibleAt: clock + 120_000 });
            const first = await store.pending({ limit: 5, leaseMs: 30_000 });
            expect(first.map((e) => e.event_id)).toEqual([a]);
            expect(await store.pending({ limit: 5, leaseMs: 30_000 })).toEqual([]);
            clock += 31_000;
            expect((await store.pending({ limit: 5, leaseMs: 30_000 })).map((e) => e.event_id)).toEqual([a]);
            clock += 120_000;
            expect((await store.pending({ limit: 5, leaseMs: 30_000 })).map((e) => e.event_id).sort()).toEqual([a, later].sort());
            await store.close();
        });

        it('does not give the same due event to two workers asking at once', async () => {
            const store = await open();
            const ids = [];
            for (let i = 0; i < 6; i++) {
                const id = crypto.randomUUID();
                ids.push(id);
                await store.record(event(id));
            }
            const claims = await Promise.all([1, 2, 3].map(() => store.pending({ limit: 6, leaseMs: 60_000 })));
            const flat = claims.flat().map((e) => e.event_id);
            expect(new Set(flat).size).toBe(flat.length);
            expect(flat.sort()).toEqual(ids.sort());
            await store.close();
        });

        it('counts failures, fails an event for good, lists it and replays it', async () => {
            let clock = 3_000_000;
            const store = await open({ now: () => clock });
            const id = crypto.randomUUID();
            await store.record(event(id));
            expect(await store.noteFailure(id, 'boom', clock + 1000)).toBe(1);
            expect(await store.noteFailure(id, 'boom again', clock + 2000)).toBe(2);
            expect(await store.get(id)).toMatchObject({ attempts: 2, last_error: 'boom again', status: 'received' });
            await store.markFailed(id, 'gave up');
            expect(await store.get(id)).toMatchObject({ status: 'failed', last_error: 'gave up' });
            expect((await store.listFailed({})).map((e) => e.event_id)).toEqual([id]);
            // A failed event is finished, so the browser sees it, and a duplicate delivery does not revive it.
            expect((await store.since({})).map((e) => e.event_id)).toEqual([id]);
            expect(await store.record(event(id))).toEqual({ inserted: false, status: 'failed' });
            expect(await store.replay(id)).toBe(true);
            expect(await store.get(id)).toMatchObject({ status: 'received', attempts: 0, done_at: null });
            expect(await store.listFailed({})).toEqual([]);
            expect(await store.replay(id)).toBe(false);
            expect((await store.pending({ limit: 5 })).map((e) => e.event_id)).toEqual([id]);
            await store.close();
        });

        it('purges every event about a contact except the deletion, which keeps only the contact id', async () => {
            const store = await open();
            const old = crypto.randomUUID();
            const other = crypto.randomUUID();
            const deletion = crypto.randomUUID();
            await store.record(event(old, { data: { contact_id: 'gone', phone: '+13125550142' } }));
            await store.record(event(other, { data: { contact_id: 'stays' } }));
            await store.record(event(deletion, { event: 'contact.deleted', data: { contact_id: 'gone', phone: '+13125550142' } }));
            await store.markProcessed(old);
            await store.markProcessed(other);
            expect(await store.purgeContact('gone', deletion)).toBe(1);
            expect(await store.get(old)).toBeNull();
            expect(await store.get(other)).not.toBeNull();
            expect((await store.get(deletion)).data).toEqual({ contact_id: 'gone' });
            await store.close();
        });

        it('keeps two sites on one store apart', async () => {
            const options = label === 'memory' ? null : { file: path.join(tmp, crypto.randomUUID() + '.sqlite') };
            if (options === null) return;
            const a = await build({ provider, site: freshSite(), env: providerEnv, ...options });
            const b = await build({ provider, site: freshSite(), env: providerEnv, ...options });
            const id = crypto.randomUUID();
            await a.record(event(id));
            await a.markProcessed(id);
            expect(await b.get(id)).toBeNull();
            expect(await b.since({})).toEqual([]);
            expect(await b.pending({ limit: 5 })).toEqual([]);
            expect((await a.since({})).map((e) => e.event_id)).toEqual([id]);
            await a.close();
            await b.close();
        });

        it('prunes finished events past the retention window and keeps recent and unfinished ones', async () => {
            let clock = Date.now();
            const store = await open({ now: () => clock, retentionHours: 1 });
            const old = crypto.randomUUID();
            const recent = crypto.randomUUID();
            const waiting = crypto.randomUUID();
            await store.record(event(old));
            await store.markProcessed(old);
            clock += 2 * 3600 * 1000;
            await store.record(event(recent));
            await store.markProcessed(recent);
            await store.record(event(waiting));
            await store.prune();
            expect((await store.since({})).map((e) => e.event_id)).toEqual([recent]);
            expect(await store.get(waiting)).not.toBeNull();
            await store.close();
        });

        it('counts events by status and reports how long the oldest has waited', async () => {
            let clock = 10_000_000;
            const store = await open({ now: () => clock });
            const done = crypto.randomUUID();
            const waiting = crypto.randomUUID();
            await store.record(event(done, { received_at: clock }));
            await store.markProcessed(done);
            await store.record(event(waiting, { received_at: clock }));
            clock += 90_000;
            expect(await store.counts()).toEqual({ received: 1, processed: 1, failed: 0, oldest_received_age_seconds: 90 });
            await store.close();
        });

        it('reports ready while it can reach its storage', async () => {
            const store = await open();
            expect(await store.ready()).toBe(true);
            await store.close();
        });
    });
}

for (const [label, provider, available, providerEnv] of stores.filter(([name]) => name !== 'memory')) {
    describe.skipIf(!available)('durable event store: ' + label, () => {
        it('keeps its events across a restart', async () => {
            const site = freshSite();
            const file = path.join(tmp, crypto.randomUUID() + '.sqlite');
            const first = await build({ provider, site, file, env: providerEnv });
            const id = crypto.randomUUID();
            await first.record(event(id));
            await first.markProcessed(id);
            await first.close();
            const second = await build({ provider, site, file, env: providerEnv });
            expect((await second.since({})).map((e) => e.event_id)).toEqual([id]);
            await second.close();
        });
    });
}

describe('event store: sqlite (connection settings)', () => {
    it('opens the file in WAL mode with synchronous NORMAL, so a commit does not wait for the disk', async () => {
        const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
        try {
            const store = await build({ provider: sqlite, site: freshSite() });
            const ran = exec.mock.calls.map(([sql]) => sql);
            expect(ran).toContain('PRAGMA journal_mode = WAL');
            expect(ran).toContain('PRAGMA synchronous = NORMAL');
            await store.close();
        } finally {
            exec.mockRestore();
        }
    });
});
