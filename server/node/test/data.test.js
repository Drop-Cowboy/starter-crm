// One suite, run against every built-in data provider (memory, sqlite, and the real Postgres from
// tests/services.compose.yml when it is up). A custom data provider should pass the same cases: they are the contract.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as dynamodb from '../src/providers/data/dynamodb.js';
import * as memory from '../src/providers/data/memory.js';
import * as postgres from '../src/providers/data/postgres.js';
import * as sqlite from '../src/providers/data/sqlite.js';
import { HAVE_DYNAMODB, HAVE_POSTGRES, POSTGRES_URL, awsTestEnv, freshSite } from './services.js';

const STARTER_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-data-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();

/**
 * Builds a provider for one site.
 *
 * @param {object} options Which provider, which site, an injectable clock and a shared sqlite file.
 * @returns {Promise<object>} The provider.
 */
async function build({ provider, site, now, file }) {
    const config = { siteId: site, root: STARTER_ROOT, events: { sqlitePath: file || path.join(tmp, crypto.randomUUID() + '.sqlite') } };
    return provider.create({ config, env: awsTestEnv({ DC_DATABASE_URL: POSTGRES_URL }), now, log: { warn() {} } });
}

const providers = [
    ['memory', memory, true],
    ['sqlite', sqlite, true],
    ['postgres', postgres, HAVE_POSTGRES],
    ['dynamodb', dynamodb, HAVE_DYNAMODB]
];

for (const [label, provider, available] of providers) {
    describe.skipIf(!available)('data provider: ' + label, () => {
        const open = (extra = {}) => build({ provider, site: freshSite(), ...extra });

        it('inserts a document with its id, owner and ISO timestamps, and reads it back', async () => {
            const data = await open({ now: () => Date.UTC(2026, 9, 13, 6, 0, 0, 123) });
            const deals = data.scope(ALICE).collection('deals');
            const made = await deals.insert({ title: 'Big', amount_cents: 500, archived: false });
            expect(made.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(made.owner_id).toBe(ALICE);
            expect(made.created_at).toBe('2026-10-13T06:00:00.123Z');
            expect(made.updated_at).toBe(made.created_at);
            expect(await deals.get(made.id)).toEqual(made);
            await data.close();
        });

        it('returns null for a missing id, and for another owner\'s document', async () => {
            const data = await open();
            const made = await data.scope(ALICE).collection('deals').insert({ title: 'Mine' });
            expect(await data.scope(BOB).collection('deals').get(made.id)).toBeNull();
            expect(await data.scope(ALICE).collection('deals').get(crypto.randomUUID())).toBeNull();
            expect(await data.scope(ALICE).collection('deals').get('not-a-uuid')).toBeNull();
            await data.close();
        });

        it('never lets one owner list, update or remove another owner\'s documents', async () => {
            const data = await open();
            const mine = data.scope(ALICE).collection('deals');
            const theirs = data.scope(BOB).collection('deals');
            const made = await mine.insert({ title: 'Mine' });
            expect(await theirs.list()).toEqual([]);
            expect(await theirs.update(made.id, { title: 'Stolen' })).toBeNull();
            expect(await theirs.remove(made.id)).toBe(false);
            expect((await mine.get(made.id)).title).toBe('Mine');
            await data.close();
        });

        it('lets the system view see and change every owner\'s documents', async () => {
            const data = await open();
            await data.scope(ALICE).collection('deals').insert({ title: 'A' });
            await data.scope(BOB).collection('deals').insert({ title: 'B' });
            const all = data.system().collection('deals');
            expect((await all.list()).map((d) => d.title).sort()).toEqual(['A', 'B']);
            const made = await all.insert({ owner_id: ALICE, title: 'C' });
            expect(made.owner_id).toBe(ALICE);
            await expect(all.insert({ title: 'no owner' })).rejects.toThrow(/owner_id/);
            await data.close();
        });

        it('lists newest first, filters by equality, and honours the limit', async () => {
            let clock = 1000;
            const data = await open({ now: () => clock++ });
            const deals = data.scope(ALICE).collection('deals');
            await deals.insert({ title: 'one', stage: 'lead', archived: false, n: 1 });
            await deals.insert({ title: 'two', stage: 'won', archived: true, n: 2 });
            await deals.insert({ title: 'three', stage: 'lead', archived: true, n: 3 });
            expect((await deals.list()).map((d) => d.title)).toEqual(['three', 'two', 'one']);
            expect((await deals.list({ where: { stage: 'lead' } })).map((d) => d.title)).toEqual(['three', 'one']);
            expect((await deals.list({ where: { stage: 'lead', archived: true } })).map((d) => d.title)).toEqual(['three']);
            expect((await deals.list({ where: { n: 2 } })).map((d) => d.title)).toEqual(['two']);
            expect((await deals.list({ limit: 2 })).map((d) => d.title)).toEqual(['three', 'two']);
            await data.close();
        });

        it('does not coerce types when filtering', async () => {
            const data = await open();
            const deals = data.scope(ALICE).collection('deals');
            await deals.insert({ title: 'a', n: 1, flag: true, text: '1' });
            expect(await deals.list({ where: { n: '1' } })).toEqual([]);
            expect(await deals.list({ where: { flag: 1 } })).toEqual([]);
            expect(await deals.list({ where: { text: 1 } })).toEqual([]);
            expect(await deals.list({ where: { flag: true } })).toHaveLength(1);
            await data.close();
        });

        it('merges a patch into the document and moves updated_at, not created_at', async () => {
            let clock = 5000;
            const data = await open({ now: () => clock++ });
            const deals = data.scope(ALICE).collection('deals');
            const made = await deals.insert({ title: 'old', stage: 'lead' });
            const changed = await deals.update(made.id, { stage: 'won' });
            expect(changed.title).toBe('old');
            expect(changed.stage).toBe('won');
            expect(changed.created_at).toBe(made.created_at);
            expect(changed.updated_at).not.toBe(made.updated_at);
            expect(await deals.update(crypto.randomUUID(), { stage: 'x' })).toBeNull();
            await data.close();
        });

        it('removes a document once', async () => {
            const data = await open();
            const deals = data.scope(ALICE).collection('deals');
            const made = await deals.insert({ title: 'gone' });
            expect(await deals.remove(made.id)).toBe(true);
            expect(await deals.remove(made.id)).toBe(false);
            expect(await deals.get(made.id)).toBeNull();
            await data.close();
        });

        it('keeps collections apart', async () => {
            const data = await open();
            await data.scope(ALICE).collection('deals').insert({ title: 'd' });
            expect(await data.scope(ALICE).collection('tickets').list()).toEqual([]);
            await data.close();
        });

        it('refuses reserved fields, bad names and unsafe filters', async () => {
            const data = await open();
            const deals = data.scope(ALICE).collection('deals');
            await expect(deals.insert({ id: 'x' })).rejects.toThrow();
            await expect(deals.insert({ owner_id: BOB })).rejects.toThrow();
            await expect(deals.update('x', { created_at: 'x' })).rejects.toThrow();
            await expect(deals.list({ where: { "title') OR 1=1 --": 'x' } })).rejects.toThrow();
            await expect(deals.list({ where: { nested: { a: 1 } } })).rejects.toThrow();
            expect(() => data.scope(ALICE).collection('Bad-Name')).toThrow();
            expect(() => data.scope('')).toThrow();
            await data.close();
        });

        it('stores awkward text exactly', async () => {
            const data = await open();
            const deals = data.scope(ALICE).collection('deals');
            const title = 'it\'s "quoted" \\ back\nline 😀 ; DROP TABLE starter_crm_data;--';
            const made = await deals.insert({ title });
            expect((await deals.get(made.id)).title).toBe(title);
            expect(await deals.list({ where: { title } })).toHaveLength(1);
            await data.close();
        });

        it('reports ready while it can reach its storage', async () => {
            const data = await open();
            expect(await data.ready()).toBe(true);
            await data.close();
        });
    });
}

for (const [label, provider, available] of providers.filter(([name]) => name !== 'memory')) {
    describe.skipIf(!available)('data provider: ' + label + ' (durable)', () => {
        it('keeps documents across a restart', async () => {
            const site = freshSite();
            const file = path.join(tmp, crypto.randomUUID() + '.sqlite');
            const first = await build({ provider, site, file });
            const made = await first.scope(ALICE).collection('deals').insert({ title: 'kept' });
            await first.close();
            const second = await build({ provider, site, file });
            expect((await second.scope(ALICE).collection('deals').get(made.id)).title).toBe('kept');
            await second.close();
        });

        it('keeps two sites on one database apart', async () => {
            const file = path.join(tmp, crypto.randomUUID() + '.sqlite');
            const one = await build({ provider, site: freshSite(), file });
            const two = await build({ provider, site: freshSite(), file });
            const made = await one.scope(ALICE).collection('deals').insert({ title: 'site one' });
            expect(await two.scope(ALICE).collection('deals').get(made.id)).toBeNull();
            expect(await two.system().collection('deals').list()).toEqual([]);
            await one.close();
            await two.close();
        });

        it.skipIf(label === 'dynamodb')('lists the applied migrations', async () => {
            const data = await build({ provider, site: freshSite() });
            expect(await data.appliedMigrations()).toContain('002_module_data');
            await data.close();
        });
    });
}

describe('data provider: sqlite (connection settings)', () => {
    it('opens the file in WAL mode with synchronous NORMAL, like the event store', async () => {
        const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
        try {
            const data = await build({ provider: sqlite, site: freshSite() });
            const ran = exec.mock.calls.map(([sql]) => sql);
            expect(ran).toContain('PRAGMA journal_mode = WAL');
            expect(ran).toContain('PRAGMA synchronous = NORMAL');
            await data.close();
        } finally {
            exec.mockRestore();
        }
    });
});

describe.skipIf(!HAVE_DYNAMODB)('data provider: dynamodb (table layout)', () => {
    it('keeps owners and sites apart even when their ids contain the key separator', async () => {
        const tangled = crypto.randomUUID();
        const data = await build({ provider: dynamodb, site: tangled + '#x' });
        const other = await build({ provider: dynamodb, site: tangled });
        const one = await data.scope('a#b').collection('deals').insert({ title: 'one' });
        const two = await data.scope('a').collection('b_deals').insert({ title: 'two' });
        expect((await data.scope('a#b').collection('deals').list()).map((d) => d.id)).toEqual([one.id]);
        expect(await data.scope('a').collection('deals').list()).toEqual([]);
        expect(await data.scope('a').collection('b_deals').get(two.id)).not.toBeNull();
        expect(await other.system().collection('deals').list()).toEqual([]);
        await data.close();
        await other.close();
    });

    it('lets the system view read, update and remove a document straight after it was written', async () => {
        const data = await build({ provider: dynamodb, site: freshSite() });
        const made = await data.scope(ALICE).collection('deals').insert({ title: 'fresh', n: 1 });
        const system = data.system().collection('deals');
        expect((await system.get(made.id)).title).toBe('fresh');
        expect((await system.update(made.id, { n: 2 })).n).toBe(2);
        expect(await system.remove(made.id)).toBe(true);
        expect(await data.scope(ALICE).collection('deals').get(made.id)).toBeNull();
        expect(await system.get(made.id)).toBeNull();
        await data.close();
    });

    it('lists across owners with fresh fields, newest first, and honours the limit through several index pages', async () => {
        let clock = 1_000_000;
        const data = await build({ provider: dynamodb, site: freshSite(), now: () => clock++ });
        const system = data.system().collection('deals');
        const ids = [];
        for (let i = 0; i < 120; i++) {
            const owner = i % 2 === 0 ? ALICE : BOB;
            ids.push((await data.scope(owner).collection('deals').insert({ n: i, even: i % 2 === 0 })).id);
        }
        await data.scope(BOB).collection('deals').update(ids[119], { n: 'changed' });
        const newest = await system.list({ limit: 3 });
        expect(newest.map((d) => d.id)).toEqual([ids[119], ids[118], ids[117]]);
        expect(newest[0].n).toBe('changed');
        const evens = await system.list({ where: { even: true }, limit: 500 });
        expect(evens).toHaveLength(60);
        expect(evens[0].id).toBe(ids[118]);
        await data.close();
    });

    it('stores numbers, booleans, nested objects and empty values as they were given', async () => {
        const data = await build({ provider: dynamodb, site: freshSite() });
        const deals = data.scope(ALICE).collection('deals');
        const made = await deals.insert({ n: 1.5, big: 12345678901, yes: true, blank: '', nothing: null, nested: { list: [1, 'two', { three: 3 }] } });
        expect(await deals.get(made.id)).toEqual(made);
        expect(made.nested.list[2].three).toBe(3);
        expect(await deals.list({ where: { n: '1.5' } })).toEqual([]);
        expect(await deals.list({ where: { yes: 'true' } })).toEqual([]);
        expect(await deals.list({ where: { n: 1.5, yes: true } })).toHaveLength(1);
        await data.close();
    });

    it('updates nested-looking field names as plain fields', async () => {
        const data = await build({ provider: dynamodb, site: freshSite() });
        const deals = data.scope(ALICE).collection('deals');
        const made = await deals.insert({ title: 'x' });
        const changed = await deals.update(made.id, { 'a.b': 1, 'with space': 2, size: 3, status: 'open' });
        expect(changed).toMatchObject({ title: 'x', 'a.b': 1, 'with space': 2, size: 3, status: 'open' });
        await data.close();
    });
});
