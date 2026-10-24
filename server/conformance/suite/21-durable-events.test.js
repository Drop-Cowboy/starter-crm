/**
 * Conformance: durable event stores, fan-outs and webhook modes.
 *
 * CONTRACT.md: "Event store", "Fan-out", "POST /webhooks/dropcowboy" (Processing), GET /api/events.
 * Protects: an event that was acknowledged is never lost (a restart, a crash before the handler),
 * every instance of a site sees every event, a slow handler never delays the acknowledgement in a queue
 * mode, a failing handler is retried (and answers 503 inline), two sites sharing one database never see
 * each other's events, and the Node and Python servers can work one BullMQ queue.
 *
 * Needs no services for the sqlite cases. The Postgres, Redis, DynamoDB, SQS and QStash cases run when Docker Compose's
 * `tests/services.compose.yml` is up (STARTER_TEST_DATABASE_URL, STARTER_TEST_REDIS_URL, STARTER_TEST_DYNAMODB_URL,
 * STARTER_TEST_SQS_URL, STARTER_TEST_QSTASH_URL; dynamodb-local, ElasticMQ and the QStash development server stand
 * in for the services) and are skipped,
 * with a notice, when it is not.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { ctx } from '../lib/context.js';
import { HAVE_DYNAMODB, HAVE_POSTGRES, HAVE_QSTASH, HAVE_REDIS, HAVE_REDIS_CLUSTER, HAVE_SQS, POSTGRES_URL, REDIS_CLUSTER_URL, REDIS_URL, awsEnv, cleanup, createQueue, commandFor, openStream, post, qstashEnv, start, until } from '../lib/durable.js';

const servers = [];
const databases = [];

/**
 * Starts a server and remembers it for cleanup.
 *
 * @param {object} options Passed to `start()`.
 * @returns {Promise<object>} The server.
 */
async function boot(options) {
    const server = await start(options);
    servers.push(server);
    return server;
}

/** Stops every server the last test started, so a slow case is not competing with the servers of earlier ones. */
async function stopServers() {
    while (servers.length > 0) {
        const server = servers.pop();
        await server.stop();
        cleanup(server);
    }
}

afterEach(stopServers);

after(async () => {
    await stopServers();
    for (const folder of databases) fs.rmSync(folder, { recursive: true, force: true });
});

const uuid = () => crypto.randomUUID();
const ids = (messages) => messages.filter((m) => m.event === 'message').map((m) => m.id);

/** Settings that put two or more instances on one site and one database file. */
function shared(extra = {}) {
    const site = uuid();
    // A folder of its own, so a container can mount just this one and still share the file.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-durable-'));
    databases.push(folder);
    return { DROPCOWBOY_SITE_ID: site, DC_SQLITE_PATH: path.join(folder, 'events.sqlite'), ...extra };
}

const serverLang = ctx.serverLang;

const BACKENDS = [
    ['sqlite with the poll fan-out', () => ({ DC_STORE: 'sqlite', DC_FANOUT: 'poll', DC_WEBHOOKS: 'store' }), true],
    ['postgres with the poll fan-out', () => ({ DC_STORE: 'postgres', DC_DATABASE_URL: POSTGRES_URL, DC_FANOUT: 'poll', DC_WEBHOOKS: 'store' }), HAVE_POSTGRES],
    ['postgres with LISTEN/NOTIFY', () => ({ DC_STORE: 'postgres', DC_DATABASE_URL: POSTGRES_URL, DC_FANOUT: 'postgres', DC_WEBHOOKS: 'store' }), HAVE_POSTGRES],
    ['postgres with Redis pub/sub and BullMQ', () => ({ DC_STORE: 'postgres', DC_DATABASE_URL: POSTGRES_URL, DC_REDIS_URL: REDIS_URL, DC_FANOUT: 'redis', DC_WEBHOOKS: 'bullmq' }), HAVE_POSTGRES && HAVE_REDIS],
    ['redis with the poll fan-out', () => ({ DC_STORE: 'redis', DC_DATA: 'sqlite', DC_REDIS_URL: REDIS_URL, DC_FANOUT: 'poll', DC_WEBHOOKS: 'store' }), HAVE_REDIS],
    ['redis with Redis pub/sub and BullMQ', () => ({ DC_STORE: 'redis', DC_DATA: 'sqlite', DC_REDIS_URL: REDIS_URL, DC_FANOUT: 'redis', DC_WEBHOOKS: 'bullmq' }), HAVE_REDIS],
    ['redis cluster with Redis pub/sub and the store outbox', () => ({ DC_STORE: 'redis', DC_DATA: 'sqlite', DC_REDIS_URL: REDIS_CLUSTER_URL, DC_REDIS_CLUSTER: 'on', DC_FANOUT: 'redis', DC_WEBHOOKS: 'store' }), HAVE_REDIS_CLUSTER],
    // BullMQ for Python cannot take a cluster client (the server says so at start-up), so this case is for the Node server.
    ['redis cluster with Redis pub/sub and BullMQ', () => ({ DC_STORE: 'redis', DC_DATA: 'sqlite', DC_REDIS_URL: REDIS_CLUSTER_URL, DC_REDIS_CLUSTER: 'on', DC_FANOUT: 'redis', DC_WEBHOOKS: 'bullmq' }), HAVE_REDIS_CLUSTER && serverLang === 'node'],
    ['dynamodb with the poll fan-out', () => ({ ...awsEnv(), DC_STORE: 'dynamodb', DC_FANOUT: 'poll', DC_WEBHOOKS: 'store' }), HAVE_DYNAMODB],
    ['dynamodb with the poll fan-out and SQS', async () => ({ ...awsEnv(), DC_STORE: 'dynamodb', DC_FANOUT: 'poll', DC_WEBHOOKS: 'sqs', DC_SQS_QUEUE_URL: await createQueue() }), HAVE_DYNAMODB && HAVE_SQS],
    ['sqlite with the poll fan-out and QStash', () => ({ DC_STORE: 'sqlite', DC_FANOUT: 'poll', DC_WEBHOOKS: 'qstash', ...qstashEnv() }), HAVE_QSTASH]
];

/** A queue belongs to one site, so a case that puts two sites on one queue does not apply to it. */
const ONE_SITE_PER_QUEUE = /SQS/;

/** QStash calls the server that published, whatever its worker setting, so there is no worker to leave off. */
const NO_WORKER = /QStash/;

for (const [label, settings, available] of BACKENDS) {
    describe(label, { skip: available ? false : 'the service is not running (see tests/services.compose.yml)' }, () => {
        it('acknowledges before a slow handler finishes, then finishes it and pushes the event', async () => {
            const server = await boot({ env: { ...shared(), ...(await settings()) } });
            const stream = await openStream(server.url);
            await stream.waitFor((m) => m.some((x) => x.event === 'replayed'));
            const eventId = uuid();
            const answer = await post(server.url, eventId, 'contact.slow');
            assert.equal(answer.status, 200);
            assert.ok(answer.elapsed < 1000, 'the acknowledgement took ' + answer.elapsed + ' ms');
            assert.equal(ids(stream.messages).includes(eventId), false, 'the event was pushed before its handler finished');
            assert.ok(await stream.waitFor((m) => ids(m).includes(eventId), 10000), 'the finished event never reached the stream');
            assert.deepEqual(server.calls(), [eventId]);
            stream.close();
        });

        it('shows an event finished on one instance to a stream open on another', async () => {
            const env = { ...shared(), ...(await settings()) };
            const first = await boot({ env });
            const second = await boot({ env });
            const stream = await openStream(second.url);
            await stream.waitFor((m) => m.some((x) => x.event === 'replayed'));
            const eventId = uuid();
            assert.equal((await post(first.url, eventId)).status, 200);
            assert.ok(await stream.waitFor((m) => ids(m).includes(eventId), 10000), 'the other instance never pushed it');
            assert.equal(ids(stream.messages).filter((id) => id === eventId).length, 1, 'the event was pushed twice');
            stream.close();
        });

        it('replays finished events to a new stream, and only those after Last-Event-ID', async () => {
            const server = await boot({ env: { ...shared(), ...(await settings()) } });
            const first = uuid();
            const second = uuid();
            await post(server.url, first);
            await until(() => server.calls().includes(first));
            await post(server.url, second);
            await until(() => server.calls().includes(second));
            const all = await openStream(server.url);
            assert.ok(await all.waitFor((m) => m.some((x) => x.event === 'replayed')));
            assert.deepEqual(ids(all.messages), [first, second]);
            all.close();
            const later = await openStream(server.url, { 'last-event-id': first });
            assert.ok(await later.waitFor((m) => m.some((x) => x.event === 'replayed')));
            assert.equal(ids(later.messages).includes(first), false);
            assert.ok(ids(later.messages).includes(second));
            later.close();
        });

        it('does not run a handler twice for a redelivered event', async () => {
            const server = await boot({ env: { ...shared(), ...(await settings()) } });
            const eventId = uuid();
            await post(server.url, eventId);
            assert.ok(await until(() => server.calls().length === 1));
            const again = await post(server.url, eventId);
            assert.equal(again.status, 200);
            assert.deepEqual(again.body, { received: true, duplicate: true });
            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.deepEqual(server.calls(), [eventId]);
        });

        it('retries a failing handler, then finishes the event once it recovers', async () => {
            const server = await boot({ env: { ...shared(), ...(await settings()) } });
            server.flag(true);
            const eventId = uuid();
            assert.equal((await post(server.url, eventId)).status, 200);
            assert.ok(await until(() => server.calls().length >= 2, 10000), 'the handler was not retried');
            server.flag(false);
            const stream = await openStream(server.url);
            assert.ok(await stream.waitFor((m) => ids(m).includes(eventId), 15000), 'the event never finished after the handler recovered');
            stream.close();
        });

        it('counts handled events at GET /api/webhooks/status', async () => {
            const server = await boot({ env: { ...shared(), ...(await settings()) } });
            const eventId = uuid();
            await post(server.url, eventId);
            assert.ok(await until(() => server.calls().includes(eventId)));
            let counts = null;
            for (let i = 0; i < 100 && !(counts && counts.processed === 1); i++) {
                counts = await (await fetch(server.url + '/api/webhooks/status')).json();
                if (counts.processed !== 1) await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.equal(counts.processed, 1, 'the status never showed the handled event');
            assert.equal(counts.failed, 0);
            assert.equal(counts.received, 0);
        });

        it('handles an event recorded while no worker was running, once a worker starts', { skip: NO_WORKER.test(label) ? 'QStash calls back the server that published; it has no worker to leave off' : false }, async () => {
            const env = { ...shared(), ...(await settings()) };
            const web = await boot({ env: { ...env, DC_WORKER_IN_PROCESS: 'off' } });
            const eventId = uuid();
            assert.equal((await post(web.url, eventId)).status, 200);
            await new Promise((resolve) => setTimeout(resolve, 600));
            assert.deepEqual(web.calls(), [], 'a server with its worker off ran the handler');
            await web.stop();

            const next = await boot({ env, root: web.root });
            assert.ok(await until(() => next.calls().includes(eventId), 10000), 'the recorded event was lost');
            const stream = await openStream(next.url);
            assert.ok(await stream.waitFor((m) => ids(m).includes(eventId), 10000), 'the finished event is not in the replay');
            stream.close();
        });

        it('keeps another site on the same database out of its stream', { skip: ONE_SITE_PER_QUEUE.test(label) ? 'a queue belongs to one site' : false }, async () => {
            const env = { ...shared(), ...(await settings()) };
            const mine = await boot({ env });
            const other = await boot({ env: { ...env, DROPCOWBOY_SITE_ID: uuid() } });
            const stream = await openStream(other.url);
            await stream.waitFor((m) => m.some((x) => x.event === 'replayed'));
            const eventId = uuid();
            await post(mine.url, eventId);
            await until(() => mine.calls().includes(eventId));
            await new Promise((resolve) => setTimeout(resolve, 1500));
            assert.equal(ids(stream.messages).includes(eventId), false);
            assert.deepEqual(other.calls(), []);
            stream.close();
        });
    });
}

describe('inline mode', () => {
    it('answers 503 while a handler fails, so Drop Cowboy retries, and 200 after it recovers', async () => {
        const server = await boot({ env: { ...shared(), DC_WEBHOOKS: 'inline' } });
        server.flag(true);
        const eventId = uuid();
        const failed = await post(server.url, eventId);
        assert.equal(failed.status, 503);
        server.flag(false);
        const retried = await post(server.url, eventId);
        assert.equal(retried.status, 200);
        const stream = await openStream(server.url);
        assert.ok(await stream.waitFor((m) => ids(m).includes(eventId)));
        stream.close();
    });
});

describe('BullMQ shared between the Node and Python servers', { skip: HAVE_REDIS ? false : 'Valkey is not running (see tests/services.compose.yml)' }, () => {
    for (const [producer, worker] of [['node', 'python'], ['python', 'node']]) {
        it('a ' + producer + ' server queues an event that a ' + worker + ' server handles', { skip: commandFor('node') && commandFor('python') ? false : 'both servers need to be runnable' }, async () => {
            const env = { DROPCOWBOY_SITE_ID: uuid(), DC_STORE: 'redis', DC_DATA: 'sqlite', DC_REDIS_URL: REDIS_URL, DC_WEBHOOKS: 'bullmq' };
            const queueing = await boot({ lang: producer, env: { ...env, DC_WORKER_IN_PROCESS: 'off' } });
            const working = await boot({ lang: worker, env });
            const eventId = uuid();
            assert.equal((await post(queueing.url, eventId)).status, 200);
            assert.ok(await until(() => working.calls().includes(eventId), 10000), 'the ' + worker + ' worker never ran the handler');
            assert.deepEqual(queueing.calls(), [], 'the producer ran the handler although its worker was off');
            const stream = await openStream(queueing.url);
            assert.ok(await stream.waitFor((m) => ids(m).includes(eventId)), 'the producer did not show the finished event');
            stream.close();
        });
    }

    it('two workers on one queue handle each event once', { skip: commandFor('node') && commandFor('python') ? false : 'both servers need to be runnable' }, async () => {
        const env = { DROPCOWBOY_SITE_ID: uuid(), DC_STORE: 'redis', DC_DATA: 'sqlite', DC_REDIS_URL: REDIS_URL, DC_WEBHOOKS: 'bullmq' };
        const node = await boot({ lang: 'node', env });
        const python = await boot({ lang: 'python', env });
        const wanted = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
        for (const eventId of wanted) assert.equal((await post(node.url, eventId)).status, 200);
        assert.ok(await until(() => node.calls().length + python.calls().length >= wanted.length, 10000));
        await new Promise((resolve) => setTimeout(resolve, 800));
        assert.deepEqual([...node.calls(), ...python.calls()].sort(), [...wanted].sort());
    });
});

describe('DynamoDB and SQS shared between the Node and Python servers', { skip: HAVE_DYNAMODB && HAVE_SQS ? false : 'dynamodb-local and ElasticMQ are not running (see tests/services.compose.yml)' }, () => {
    const both = commandFor('node') && commandFor('python') ? false : 'both servers need to be runnable';
    const settings = async () => ({ ...awsEnv(), DROPCOWBOY_SITE_ID: uuid(), DC_STORE: 'dynamodb', DC_FANOUT: 'poll', DC_WEBHOOKS: 'sqs', DC_SQS_QUEUE_URL: await createQueue() });

    for (const [producer, worker] of [['node', 'python'], ['python', 'node']]) {
        it('a ' + producer + ' server queues an event that a ' + worker + ' server handles, and both read the same table', { skip: both }, async () => {
            const env = await settings();
            const queueing = await boot({ lang: producer, env: { ...env, DC_WORKER_IN_PROCESS: 'off' } });
            const working = await boot({ lang: worker, env });
            const eventId = uuid();
            assert.equal((await post(queueing.url, eventId)).status, 200);
            assert.ok(await until(() => working.calls().includes(eventId), 15000), 'the ' + worker + ' worker never ran the handler');
            assert.deepEqual(queueing.calls(), [], 'the producer ran the handler although its worker was off');
            const stream = await openStream(queueing.url);
            assert.ok(await stream.waitFor((m) => ids(m).includes(eventId)), 'the producer did not show the finished event');
            stream.close();
        });
    }
});
