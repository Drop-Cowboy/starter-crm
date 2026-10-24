/**
 * Conformance: modules and the Deals example.
 *
 * CONTRACT.md: "Modules", "Module data", "Input validation".
 * Protects: Deals create, list, read, update and delete over `/api/modules/deals`; owner isolation (a user never
 * sees, changes or deletes another user's deal, and cannot tell it from a missing one); input validation
 * (400 invalid_request with the field named, 415 for a body that is not JSON); sign-in required (401);
 * a signed `contact.deleted` webhook archives that contact's deals for every owner; and two sites sharing one
 * database never see each other's deals.
 *
 * The site-isolation cases start their own servers on sqlite (and Postgres when Docker Compose's
 * `tests/services.compose.yml` is up) and need no services otherwise.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { assertEnvelope, call, client, deliver, postJson, UUID } from '../lib/context.js';
import { HAVE_DYNAMODB, HAVE_POSTGRES, POSTGRES_URL, awsEnv, cleanup, post, start } from '../lib/durable.js';

const MODE = 'custom';
const BASE = '/api/modules/deals';
const uuid = () => crypto.randomUUID();

/** Headers for a request signed in as `user`, from a client of its own so the rate limit never interferes. */
const as = (user) => ({ 'x-test-user': user, ...client() });

const create = (user, body) => postJson(MODE, BASE, body, as(user));
const list = (user, query = '') => call(MODE, BASE + query, { headers: as(user) });
const read = (user, id) => call(MODE, BASE + '/' + id, { headers: as(user) });
const update = (user, id, body) => postJson(MODE, BASE + '/' + id, body, as(user));
const remove = (user, id) => call(MODE, BASE + '/' + id, { method: 'DELETE', headers: as(user) });

describe('Deals: sign-in', () => {
    it('answers 401 unauthenticated without a user', async () => {
        assertEnvelope(await call(MODE, BASE, { headers: client() }), 401, 'unauthenticated');
        assertEnvelope(await postJson(MODE, BASE, { title: 'x' }, client()), 401, 'unauthenticated');
        assertEnvelope(await call(MODE, BASE + '/' + uuid(), { method: 'DELETE', headers: client() }), 401, 'unauthenticated');
    });
});

describe('Deals: create, read, update, delete', () => {
    it('creates a deal with the defaults filled in', async () => {
        const user = uuid();
        const res = await create(user, { title: 'Roof for the Garcias' });
        assert.equal(res.status, 201);
        const deal = res.body.deal;
        assert.match(deal.id, UUID);
        assert.equal(deal.owner_id, user);
        assert.equal(deal.title, 'Roof for the Garcias');
        assert.equal(deal.stage, 'lead');
        assert.equal(deal.amount_cents, 0);
        assert.equal(deal.currency, 'USD');
        assert.equal(deal.archived, false);
        assert.equal(deal.contact_id, null);
        assert.match(deal.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        assert.equal(deal.updated_at, deal.created_at);
    });

    it('reads a deal back, and lists the newest first', async () => {
        const user = uuid();
        const first = (await create(user, { title: 'first' })).body.deal;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = (await create(user, { title: 'second', stage: 'qualified', amount_cents: 2500, currency: 'EUR' })).body.deal;
        assert.deepEqual((await read(user, first.id)).body, { deal: first });
        const listed = await list(user);
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.body.deals.map((d) => d.title), ['second', 'first']);
        assert.equal(listed.body.deals[0].amount_cents, 2500);
        assert.equal(listed.body.deals[0].currency, 'EUR');
        assert.equal(listed.body.deals[0].id, second.id);
    });

    it('filters the list by stage, contact and archived', async () => {
        const user = uuid();
        const contact = uuid();
        await create(user, { title: 'a', stage: 'won' });
        const linked = (await create(user, { title: 'b', contact_id: contact.toUpperCase() })).body.deal;
        assert.equal(linked.contact_id, contact);
        const archived = (await create(user, { title: 'c' })).body.deal;
        await update(user, archived.id, { archived: true });
        assert.deepEqual((await list(user, '?stage=won')).body.deals.map((d) => d.title), ['a']);
        assert.deepEqual((await list(user, '?contact_id=' + contact)).body.deals.map((d) => d.title), ['b']);
        assert.deepEqual((await list(user, '?archived=true')).body.deals.map((d) => d.title), ['c']);
        assert.deepEqual((await list(user, '?archived=false')).body.deals.map((d) => d.title).sort(), ['a', 'b']);
        assert.deepEqual((await list(user, '?archived=all')).body.deals.map((d) => d.title).sort(), ['a', 'b', 'c']);
        assertEnvelope(await list(user, '?stage=nope'), 400, 'invalid_request');
        assertEnvelope(await list(user, '?archived=maybe'), 400, 'invalid_request');
    });

    it('updates some fields, keeps the rest and moves updated_at', async () => {
        const user = uuid();
        const deal = (await create(user, { title: 'before', amount_cents: 100 })).body.deal;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const res = await update(user, deal.id, { stage: 'won', notes: 'signed' });
        assert.equal(res.status, 200);
        assert.equal(res.body.deal.title, 'before');
        assert.equal(res.body.deal.amount_cents, 100);
        assert.equal(res.body.deal.stage, 'won');
        assert.equal(res.body.deal.notes, 'signed');
        assert.equal(res.body.deal.created_at, deal.created_at);
        assert.notEqual(res.body.deal.updated_at, deal.updated_at);
    });

    it('marks a deal archived by hand with a reason, and clears it again', async () => {
        const user = uuid();
        const deal = (await create(user, { title: 'x' })).body.deal;
        const archived = (await update(user, deal.id, { archived: true })).body.deal;
        assert.equal(archived.archived, true);
        assert.equal(archived.archived_reason, 'manual');
        const back = (await update(user, deal.id, { archived: false })).body.deal;
        assert.equal(back.archived, false);
        assert.equal(back.archived_reason, null);
    });

    it('deletes a deal once', async () => {
        const user = uuid();
        const deal = (await create(user, { title: 'gone' })).body.deal;
        const res = await remove(user, deal.id);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { deleted: true, id: deal.id });
        assertEnvelope(await remove(user, deal.id), 404, 'deal_not_found');
        assertEnvelope(await read(user, deal.id), 404, 'deal_not_found');
    });

    it('answers 404 deal_not_found for an id that is not a UUID', async () => {
        const user = uuid();
        assertEnvelope(await read(user, 'nope'), 404, 'deal_not_found');
        assertEnvelope(await update(user, 'nope', { stage: 'won' }), 404, 'deal_not_found');
        assertEnvelope(await remove(user, 'nope'), 404, 'deal_not_found');
    });
});

describe('Deals: owner isolation', () => {
    it('never shows, changes or deletes another user\'s deal, and answers as if it did not exist', async () => {
        const alice = uuid();
        const bob = uuid();
        const deal = (await create(alice, { title: 'Alice only' })).body.deal;
        assert.deepEqual((await list(bob)).body, { deals: [] });
        assertEnvelope(await read(bob, deal.id), 404, 'deal_not_found');
        assertEnvelope(await update(bob, deal.id, { title: 'Bob was here' }), 404, 'deal_not_found');
        assertEnvelope(await remove(bob, deal.id), 404, 'deal_not_found');
        const still = (await read(alice, deal.id)).body.deal;
        assert.equal(still.title, 'Alice only');
        assert.equal((await list(alice)).body.deals.length, 1);
    });

    it('ignores an owner_id in the body: the deal always belongs to the signed-in user', async () => {
        const alice = uuid();
        const bob = uuid();
        assertEnvelope(await create(alice, { title: 'x', owner_id: bob }), 400, 'invalid_request');
        assert.deepEqual((await list(bob)).body, { deals: [] });
    });
});

describe('Deals: input validation', () => {
    const user = uuid();
    const bad = [
        ['a missing title', {}, /title/],
        ['an empty title', { title: '' }, /title/],
        ['a title that is not text', { title: 5 }, /title/],
        ['a title that is too long', { title: 'x'.repeat(201) }, /title/],
        ['a negative amount', { title: 'x', amount_cents: -1 }, /amount_cents/],
        ['a fractional amount', { title: 'x', amount_cents: 1.5 }, /amount_cents/],
        ['an amount that is text', { title: 'x', amount_cents: '5' }, /amount_cents/],
        ['a currency in lowercase', { title: 'x', currency: 'usd' }, /currency/],
        ['a currency with a trailing newline', { title: 'x', currency: 'USD\n' }, /currency/],
        ['an unknown stage', { title: 'x', stage: 'maybe' }, /stage/],
        ['a contact id that is not a UUID', { title: 'x', contact_id: 'nope' }, /contact_id/],
        ['notes that are too long', { title: 'x', notes: 'n'.repeat(2001) }, /notes/],
        ['a field that does not exist', { title: 'x', color: 'red' }, /color/],
        ['a body that is an array', [], /body/]
    ];

    for (const [label, body, field] of bad) {
        it('rejects ' + label + ' with 400 invalid_request naming the field', async () => {
            const res = await postJson(MODE, BASE, JSON.stringify(body), as(user));
            assertEnvelope(res, 400, 'invalid_request');
            assert.match(res.body.error.message, field);
            assert.match(res.body.error.message, /\.$/);
        });
    }

    it('rejects an update that changes nothing', async () => {
        const deal = (await create(user, { title: 'x' })).body.deal;
        assertEnvelope(await update(user, deal.id, {}), 400, 'invalid_request');
        assertEnvelope(await update(user, deal.id, { stage: 'nope' }), 400, 'invalid_request');
    });

    it('rejects a body that is not JSON with 415 unsupported_media_type', async () => {
        const res = await call(MODE, BASE, { method: 'POST', headers: { 'content-type': 'text/plain', ...as(user) }, body: 'title=x' });
        assertEnvelope(res, 415, 'unsupported_media_type');
    });

    it('rejects a body that is the JSON value null with 400', async () => {
        const res = await call(MODE, BASE, { method: 'POST', headers: { 'content-type': 'application/json', ...as(user) }, body: 'null' });
        assert.equal(res.status, 400);
    });

    it('rejects malformed JSON with 400', async () => {
        const res = await call(MODE, BASE, { method: 'POST', headers: { 'content-type': 'application/json', ...as(user) }, body: '{"title":' });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code.startsWith('invalid_'), true);
    });

    it('accepts a UUID contact id in any case and stores it in lowercase', async () => {
        const contact = uuid();
        const res = await create(user, { title: 'x', contact_id: contact.toUpperCase() });
        assert.equal(res.body.deal.contact_id, contact);
    });
});

describe('Deals: a deleted contact archives its deals', () => {
    it('archives every owner\'s deals for that contact, once, and leaves the rest', async () => {
        const alice = uuid();
        const bob = uuid();
        const contact = uuid();
        const other = uuid();
        const a = (await create(alice, { title: 'Alice deal', contact_id: contact })).body.deal;
        const b = (await create(bob, { title: 'Bob deal', contact_id: contact })).body.deal;
        const c = (await create(alice, { title: 'Other contact', contact_id: other })).body.deal;
        const d = (await create(alice, { title: 'No contact' })).body.deal;

        const body = JSON.stringify({ event_id: uuid(), event: 'contact.deleted', event_at: Date.now(), data: { contact_id: contact } });
        const res = await deliver(MODE, body);
        assert.equal(res.status, 200);

        let archivedA;
        let archivedB;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            archivedA = (await read(alice, a.id)).body.deal;
            archivedB = (await read(bob, b.id)).body.deal;
            if (archivedA.archived && archivedB.archived) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(archivedA.archived, true);
        assert.equal(archivedA.archived_reason, 'contact_deleted');
        assert.equal(archivedB.archived, true);
        assert.equal(archivedB.archived_reason, 'contact_deleted');
        assert.equal((await read(alice, c.id)).body.deal.archived, false);
        assert.equal((await read(alice, d.id)).body.deal.archived, false);
    });
});

describe('Deals: two sites on one database', () => {
    const servers = [];
    const folders = [];
    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            await server.stop();
            cleanup(server);
        }
    });
    after(() => {
        for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
    });

    const USER = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
    const BACKENDS = [
        ['sqlite', () => {
            const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-deals-'));
            folders.push(folder);
            return { DC_STORE: 'sqlite', DC_SQLITE_PATH: path.join(folder, 'crm.sqlite') };
        }, true],
        ['postgres', () => ({ DC_STORE: 'postgres', DC_DATABASE_URL: POSTGRES_URL }), HAVE_POSTGRES],
        ['dynamodb', () => ({ ...awsEnv(), DC_STORE: 'dynamodb' }), HAVE_DYNAMODB]
    ];

    for (const [label, settings, available] of BACKENDS) {
        it('keeps ' + label + ' deals apart by site, even for the same user id', { skip: available ? false : 'the service is not running (see tests/services.compose.yml)' }, async () => {
            const shared = settings();
            const one = await start({ env: { ...shared, DROPCOWBOY_SITE_ID: uuid(), STARTER_CRM_USER_ID: USER } });
            servers.push(one);
            const two = await start({ env: { ...shared, DROPCOWBOY_SITE_ID: uuid(), STARTER_CRM_USER_ID: USER } });
            servers.push(two);
            const made = await fetch(one.url + BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'site one' }) });
            assert.equal(made.status, 201);
            const deal = (await made.json()).deal;
            assert.equal(deal.owner_id, USER);
            const fromOne = await (await fetch(one.url + BASE)).json();
            assert.deepEqual(fromOne.deals.map((d) => d.title), ['site one']);
            const fromTwo = await (await fetch(two.url + BASE)).json();
            assert.deepEqual(fromTwo.deals, []);
            assert.equal((await fetch(two.url + BASE + '/' + deal.id)).status, 404);
            assert.equal((await fetch(two.url + BASE + '/' + deal.id, { method: 'DELETE' })).status, 404);
            assert.equal((await fetch(one.url + BASE + '/' + deal.id)).status, 200);
        });
    }

    it('keeps deals across a restart on a durable store', async () => {
        const shared = BACKENDS[0][1]();
        const site = uuid();
        const first = await start({ env: { ...shared, DROPCOWBOY_SITE_ID: site, STARTER_CRM_USER_ID: USER } });
        servers.push(first);
        const made = await fetch(first.url + BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'kept' }) });
        const deal = (await made.json()).deal;
        await first.stop();
        servers.pop();
        const second = await start({ env: { ...shared, DROPCOWBOY_SITE_ID: site, STARTER_CRM_USER_ID: USER }, root: first.root });
        servers.push(second);
        const res = await fetch(second.url + BASE + '/' + deal.id);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).deal.title, 'kept');
    });
});

describe('Deals: on DynamoDB', { skip: HAVE_DYNAMODB ? false : 'dynamodb-local is not running (see tests/services.compose.yml)' }, () => {
    const servers = [];
    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            await server.stop();
            cleanup(server);
        }
    });

    it('archives a deleted contact\'s deals through the system view, and keeps the deals of other contacts', async () => {
        const server = await start({ env: { ...awsEnv(), DC_STORE: 'dynamodb', DROPCOWBOY_SITE_ID: uuid(), STARTER_CRM_USER_ID: uuid() } });
        servers.push(server);
        // The contact id `post()` puts in every event.
        const contact = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
        const json = { 'content-type': 'application/json' };
        const make = async (body) => (await (await fetch(server.url + BASE, { method: 'POST', headers: json, body: JSON.stringify(body) })).json()).deal;
        const mine = [await make({ title: 'one', contact_id: contact }), await make({ title: 'two', contact_id: contact })];
        const kept = await make({ title: 'other contact', contact_id: uuid() });
        assert.equal((await post(server.url, uuid(), 'contact.deleted')).status, 200);
        const archived = async (id) => (await (await fetch(server.url + BASE + '/' + id)).json()).deal.archived;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !(await archived(mine[0].id) && await archived(mine[1].id))) await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(await archived(mine[0].id), true);
        assert.equal(await archived(mine[1].id), true);
        assert.equal(await archived(kept.id), false);
    });
});
