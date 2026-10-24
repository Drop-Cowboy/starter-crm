// The `qstash` webhook mode against the real QStash development server (tests/services.compose.yml): it publishes and
// delivers with real signatures, so the signature check is proved on the wire format and not on a copy of it. The suites
// that need it skip, with a notice, when it is not running. The checks that need no server always run.
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessor } from '../src/processor.js';
import { createRuntime } from '../src/runtime.js';
import * as localFanout from '../src/providers/fanout/local.js';
import * as memoryStore from '../src/providers/store/memory.js';
import * as qstash from '../src/providers/webhooks/qstash.js';
import { HAVE_QSTASH, QSTASH_DEV } from './services.js';
import { makeConfig, silentLog } from './helpers.js';

const HOST = 'host.docker.internal';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return true;
        await wait(100);
    }
    return false;
}

describe('webhooks: qstash settings', () => {
    const good = { QSTASH_TOKEN: 't', QSTASH_CURRENT_SIGNING_KEY: 'c', QSTASH_NEXT_SIGNING_KEY: 'n', DC_PUBLIC_URL: 'https://crm.example.test' };

    it('accepts a token, both signing keys and a public address', () => {
        expect(qstash.validate(good)).toEqual([]);
    });

    it('names every setting that is missing, each once', () => {
        const found = qstash.validate({});
        expect(found.map((item) => item.code)).toEqual(['missing_qstash_setting', 'missing_qstash_setting', 'missing_qstash_setting', 'missing_qstash_public_url']);
        expect(found.map((item) => item.message).join(' ')).toMatch(/QSTASH_TOKEN[\s\S]*QSTASH_CURRENT_SIGNING_KEY[\s\S]*QSTASH_NEXT_SIGNING_KEY/);
    });

    it('uses the project domain on Vercel when DC_PUBLIC_URL is unset', () => {
        const rest = { ...good };
        delete rest.DC_PUBLIC_URL;
        expect(qstash.validate({ ...rest, VERCEL_PROJECT_PRODUCTION_URL: 'crm.example.test' })).toEqual([]);
        expect(qstash.publicOrigin({ ...rest, VERCEL_PROJECT_PRODUCTION_URL: 'crm.example.test' })).toBe('https://crm.example.test');
        expect(qstash.publicOrigin({ ...good, DC_PUBLIC_URL: 'https://crm.example.test///' })).toBe('https://crm.example.test');
        expect(qstash.publicOrigin({ ...rest, NETLIFY: 'true', URL: 'https://crm.example.test/' })).toBe('https://crm.example.test');
        expect(qstash.publicOrigin({ ...rest, URL: 'https://crm.example.test' })).toBe('');
    });

    it('requires https in production and a real URL for QSTASH_URL', () => {
        expect(qstash.validate({ ...good, DC_ENV: 'production', DC_PUBLIC_URL: 'http://crm.example.test' })[0].code).toBe('insecure_qstash_public_url');
        expect(qstash.validate({ ...good, DC_PUBLIC_URL: 'not a url' })[0].code).toBe('invalid_qstash_public_url');
        expect(qstash.validate({ ...good, QSTASH_URL: 'nope' })[0].code).toBe('invalid_qstash_url');
    });
});

/**
 * A fake of the SDK's client and receiver, for the checks that need no server: publishing records the request, and a
 * signature is valid when it equals `valid-for:<url>`.
 *
 * @returns {{ sdk: object, published: object[] }} The fake and what it was asked to publish.
 */
function fakeSdk() {
    const published = [];
    return {
        published,
        sdk: {
            Client: class {
                async publishJSON(request) {
                    published.push(request);
                    return { messageId: crypto.randomUUID() };
                }
            },
            Receiver: class {
                async verify({ signature, url }) {
                    return signature === 'valid-for:' + url;
                }
            }
        }
    };
}

describe('webhooks: qstash with a stand-in SDK', () => {
    async function build(handlers = {}) {
        const config = makeConfig({ DC_WEBHOOK_MAX_ATTEMPTS: '2' });
        const store = memoryStore.create({ config });
        const fanout = localFanout.create();
        const processor = createProcessor({ config, store, fanout, handlers, log: silentLog });
        const { sdk, published } = fakeSdk();
        const dispatcher = await qstash.create({ config, env: { ...QSTASH_DEV, DC_PUBLIC_URL: 'https://crm.example.test' }, processor, log: silentLog, sdk });
        const runtime = createRuntime({ config, store, fanout, dispatcher, processor, log: silentLog });
        const app = createApp(config, { log: silentLog, runtime });
        return { store, dispatcher, published, config, app };
    }

    async function post(app, body, headers = {}) {
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            return await fetch('http://127.0.0.1:' + server.address().port + qstash.JOBS_PATH, { method: 'POST', body, headers });
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }

    async function record(store) {
        const eventId = crypto.randomUUID();
        await store.record({ event_id: eventId, event: 'contact.rvm.status', event_at: null, received_at: Date.now(), attempt: 1, data: {} }, { visibleAt: 0 });
        return eventId;
    }

    it('publishes only the event id and the site, to the internal route, with the backoff as its retry delay', async () => {
        const { dispatcher, published, config } = await build();
        const id = crypto.randomUUID();
        expect(await dispatcher.dispatch(id)).toEqual({ outcome: 'queued' });
        expect(published).toEqual([{
            url: 'https://crm.example.test/internal/webhook-jobs',
            body: { event_id: id, site_id: config.siteId },
            retryDelay: 'min(300000, pow(2, retried) * 1000)'
        }]);
    });

    it('refuses an unsigned call, a call signed for another address, and runs no handler for either', async () => {
        let ran = 0;
        const { app, store } = await build({ 'contact.rvm.status': async () => { ran++; } });
        const id = await record(store);
        const body = JSON.stringify({ event_id: id });
        for (const headers of [{}, { 'upstash-signature': 'valid-for:https://elsewhere.example.test/internal/webhook-jobs' }]) {
            const response = await post(app, body, headers);
            expect(response.status).toBe(401);
            expect((await response.json()).error.code).toBe('invalid_signature');
        }
        expect(ran).toBe(0);
        expect((await store.get(id)).status).toBe('received');
    });

    it('runs the handlers for a signed call and finishes the event', async () => {
        const seen = [];
        const { app, store } = await build({ 'contact.rvm.status': async (event) => { seen.push(event.event_id); } });
        const id = await record(store);
        const response = await post(app, JSON.stringify({ event_id: id }), { 'upstash-signature': 'valid-for:https://crm.example.test/internal/webhook-jobs' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ outcome: 'processed' });
        expect(seen).toEqual([id]);
    });

    it('answers 503 while a retry is due, so QStash tries again, and 200 once the attempts are used up', async () => {
        const { app, store } = await build({ 'contact.rvm.status': async () => { throw new Error('boom'); } });
        const id = await record(store);
        const headers = { 'upstash-signature': 'valid-for:https://crm.example.test/internal/webhook-jobs' };
        const first = await post(app, JSON.stringify({ event_id: id }), headers);
        expect(first.status).toBe(503);
        expect((await first.json()).error.code).toBe('handler_failed');
        const second = await post(app, JSON.stringify({ event_id: id }), headers);
        expect(second.status).toBe(200);
        expect((await store.get(id)).status).toBe('failed');
    });

    it('drops a signed message that is not an event id', async () => {
        const { app } = await build();
        const response = await post(app, JSON.stringify({ nothing: true }), { 'upstash-signature': 'valid-for:https://crm.example.test/internal/webhook-jobs' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ignored: true });
    });

    it('is not under the static files: GET on the internal path is a 404, not the app', async () => {
        const { app } = await build();
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const response = await fetch('http://127.0.0.1:' + server.address().port + qstash.JOBS_PATH, { headers: { accept: 'text/html' } });
            expect(response.status).toBe(404);
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

const servers = [];
afterEach(async () => {
    while (servers.length) {
        const server = servers.pop();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

describe.skipIf(!HAVE_QSTASH)('webhooks: qstash against the QStash development server', () => {
    /**
     * Starts a real server for the mode on all interfaces, so the QStash container can reach it.
     *
     * @param {Record<string, Function>} handlers Webhook handlers.
     * @returns {Promise<{ store: object, dispatcher: object, port: number, calls: number[] }>} The pieces.
     */
    async function live(handlers) {
        const config = makeConfig({ DC_WEBHOOK_MAX_ATTEMPTS: '5' });
        const store = memoryStore.create({ config });
        const fanout = localFanout.create();
        const processor = createProcessor({ config, store, fanout, handlers, log: silentLog });
        const probe = http.createServer();
        await new Promise((resolve) => probe.listen(0, '0.0.0.0', resolve));
        const { port } = probe.address();
        await new Promise((resolve) => probe.close(resolve));
        const dispatcher = await qstash.create({ config, env: { ...QSTASH_DEV, DC_PUBLIC_URL: 'http://' + HOST + ':' + port }, processor, log: silentLog });
        const runtime = createRuntime({ config, store, fanout, dispatcher, processor, log: silentLog });
        const app = createApp(config, { log: silentLog, runtime });
        const server = await new Promise((resolve) => { const s = app.listen(port, '0.0.0.0', () => resolve(s)); });
        servers.push(server);
        return { store, dispatcher, port };
    }

    async function record(store) {
        const eventId = crypto.randomUUID();
        await store.record({ event_id: eventId, event: 'contact.rvm.status', event_at: null, received_at: Date.now(), attempt: 1, data: {} }, { visibleAt: 0 });
        return eventId;
    }

    it('delivers a published event with a real signature, and the handlers run once', async () => {
        const seen = [];
        const { store, dispatcher } = await live({ 'contact.rvm.status': async (event) => { seen.push(event.event_id); } });
        const id = await record(store);
        await dispatcher.dispatch(id);
        expect(await until(async () => (await store.get(id)).status === 'processed')).toBe(true);
        expect(seen).toEqual([id]);
    });

    it('retries after the backoff when a handler fails, and finishes when it recovers', async () => {
        let calls = 0;
        const { store, dispatcher } = await live({ 'contact.rvm.status': async () => { calls++; if (calls < 2) throw new Error('first attempt fails'); } });
        const id = await record(store);
        await dispatcher.dispatch(id);
        expect(await until(async () => (await store.get(id)).status === 'processed', 30000)).toBe(true);
        expect(calls).toBe(2);
    });

    it('refuses a call that carries a signature made with a key it does not know', async () => {
        const { store, port } = await live({});
        const id = await record(store);
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const header = encode({ alg: 'HS256', typ: 'JWT' });
        const body = JSON.stringify({ event_id: id });
        const claims = encode({
            iss: 'Upstash', sub: 'http://' + HOST + ':' + port + qstash.JOBS_PATH, exp: Math.floor(Date.now() / 1000) + 300,
            nbf: Math.floor(Date.now() / 1000) - 5, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(),
            body: crypto.createHash('sha256').update(body).digest('base64url')
        });
        const signature = crypto.createHmac('sha256', 'a-key-that-is-not-configured').update(header + '.' + claims).digest('base64url');
        const response = await fetch('http://127.0.0.1:' + port + qstash.JOBS_PATH, { method: 'POST', body, headers: { 'upstash-signature': header + '.' + claims + '.' + signature } });
        expect(response.status).toBe(401);
        expect((await store.get(id)).status).toBe('received');
    });
});
