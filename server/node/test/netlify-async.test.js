// The `netlify-async` webhook mode against a stand-in for the Async Workloads router: the router only exists on a
// Netlify site with the extension, so the real thing is proved by the sandbox deploy (npm run test:deployed). Here the
// dispatcher's sends are captured by a fake fetch, and consume() is driven the way the workload function calls it.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProcessor } from '../src/processor.js';
import * as localFanout from '../src/providers/fanout/local.js';
import * as memoryStore from '../src/providers/store/memory.js';
import * as netlifyAsync from '../src/providers/webhooks/netlify-async.js';
import { makeConfig, silentLog } from './helpers.js';

const KEY = 'test-key';
const SITE = 'https://crm-sandbox.netlify.app';

/**
 * A fetch that records each request and answers with `status`.
 *
 * @param {number} [status] The router's answer.
 * @returns {{ fetch: Function, sent: object[] }} The fake and what it received.
 */
function fakeRouter(status = 202) {
    const sent = [];
    return {
        sent,
        fetch: async (url, init) => {
            sent.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
            return new Response(JSON.stringify({ sendStatus: status < 300 ? 'succeeded' : 'failed' }), { status });
        }
    };
}

async function build({ handlers = {}, maxAttempts = 3, status, env = {}, requestUrl } = {}) {
    const config = makeConfig({ DC_STORE: 'sqlite', DC_SQLITE_PATH: ':memory:', DC_WEBHOOKS: 'inline', DC_WEBHOOK_MAX_ATTEMPTS: String(maxAttempts) });
    const store = memoryStore.create({ config });
    const fanout = localFanout.create();
    const processor = createProcessor({ config, store, fanout, handlers, log: silentLog });
    const router = fakeRouter(status);
    const merged = { NETLIFY: 'true', URL: SITE, AWL_API_KEY: KEY, ...env };
    const dispatcher = await netlifyAsync.create({ config, env: merged, processor, log: silentLog, fetch: router.fetch, requestUrl: requestUrl || (() => undefined) });
    return { config, store, dispatcher, router };
}

async function record(store, event = 'contact.rvm.status') {
    const eventId = crypto.randomUUID();
    await store.record({ event_id: eventId, event, event_at: null, received_at: Date.now(), attempt: 1, data: {} }, { visibleAt: 0 });
    return eventId;
}

describe('webhooks: netlify-async', () => {
    it('sends only the event id and the site to the router with the key, and says it queued', async () => {
        const { dispatcher, router, config } = await build();
        const id = crypto.randomUUID();
        expect(await dispatcher.dispatch(id)).toEqual({ outcome: 'queued' });
        expect(router.sent).toHaveLength(1);
        const [sent] = router.sent;
        expect(sent.url).toBe(SITE + netlifyAsync.ROUTER_PATH + '?events=' + netlifyAsync.EVENT);
        expect(sent.method).toBe('POST');
        expect(sent.headers.authorization).toBe('Bearer ' + KEY);
        expect(sent.body.eventName).toBe(netlifyAsync.EVENT);
        expect(sent.body.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(sent.body.data).toEqual({ event_id: id, site_id: config.siteId });
        expect(sent.signal).toBeInstanceOf(AbortSignal);
    });

    it('sends to the deploy serving the request, so a preview runs its own events', async () => {
        const preview = 'https://deploy-preview-12--crm-sandbox.netlify.app';
        const { dispatcher, router } = await build({ requestUrl: () => preview + '/webhooks/dropcowboy' });
        await dispatcher.dispatch(crypto.randomUUID());
        expect(router.sent[0].url.startsWith(preview + netlifyAsync.ROUTER_PATH)).toBe(true);
    });

    it('prefers DC_PUBLIC_URL over the request and the site address', async () => {
        const { dispatcher, router } = await build({ env: { DC_PUBLIC_URL: 'https://crm.example.com/' }, requestUrl: () => SITE + '/x' });
        await dispatcher.dispatch(crypto.randomUUID());
        expect(router.sent[0].url.startsWith('https://crm.example.com' + netlifyAsync.ROUTER_PATH)).toBe(true);
    });

    it('lets a refused send reach the webhook, so it answers 503 and Drop Cowboy retries', async () => {
        const { dispatcher } = await build({ status: 401 });
        await expect(dispatcher.dispatch(crypto.randomUUID())).rejects.toThrow('HTTP 401');
    });

    it('processes an event the workload receives, and finishes it', async () => {
        const seen = [];
        const { dispatcher, store } = await build({ handlers: { 'contact.rvm.status': async (event) => { seen.push(event.event_id); } } });
        const id = await record(store);
        expect(await dispatcher.consume({ event_id: id }, 0)).toEqual({ outcome: 'processed' });
        expect(seen).toEqual([id]);
        expect((await store.get(id)).status).toBe('processed');
    });

    it('is safe when Async Workloads runs an event twice', async () => {
        const seen = [];
        const { dispatcher, store } = await build({ handlers: { 'contact.rvm.status': async (event) => { seen.push(event.event_id); } } });
        const id = await record(store);
        await dispatcher.consume({ event_id: id }, 0);
        const again = await dispatcher.consume({ event_id: id }, 1);
        expect(again.outcome).not.toBe('retry');
        expect(seen).toHaveLength(1);
    });

    it('asks for a retry after the backoff when a handler fails, then gives up after the attempts', async () => {
        const { dispatcher, store } = await build({ maxAttempts: 2, handlers: { 'contact.rvm.status': async () => { throw new Error('boom'); } } });
        const id = await record(store);
        const first = await dispatcher.consume({ event_id: id }, 0);
        expect(first).toMatchObject({ outcome: 'retry', retryAfterMs: 1000 });
        expect((await store.get(id)).status).toBe('received');
        const second = await dispatcher.consume({ event_id: id }, 1);
        expect(second.outcome).toBe('failed');
        expect((await store.get(id)).status).toBe('failed');
    });

    it('doubles the retry delay each attempt and caps it at five minutes', () => {
        expect([0, 1, 2, 3].map(netlifyAsync.retryAfterMs)).toEqual([1000, 2000, 4000, 8000]);
        expect(netlifyAsync.retryAfterMs(30)).toBe(300000);
        expect(netlifyAsync.retryAfterMs(undefined)).toBe(1000);
    });

    it('drops an event that is not an event id instead of retrying it forever', async () => {
        const { dispatcher } = await build();
        for (const data of [{}, { event_id: 42 }, null, 'text']) {
            expect((await dispatcher.consume(data, 0)).outcome).toBe('ignored');
        }
    });

    it('adds no route and nothing runs in the background', async () => {
        const { dispatcher } = await build();
        expect(dispatcher.routes).toBeUndefined();
        await dispatcher.start();
        await dispatcher.stop();
        expect(await dispatcher.ready()).toBe(true);
    });

    it('re-queues events by sending them again', async () => {
        const { dispatcher, router } = await build();
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        await dispatcher.sweep(ids);
        expect(router.sent.map((item) => item.body.data.event_id)).toEqual(ids);
    });

    describe('apiKey', () => {
        it('uses the highest-priority key, as the extension does', () => {
            expect(netlifyAsync.apiKey({ AWL_API_KEY: 'plain' })).toBe('plain');
            expect(netlifyAsync.apiKey({ AWL_API_KEY: 'plain', AWL_API_KEY_P0: 'p0' })).toBe('p0');
            expect(netlifyAsync.apiKey({ AWL_API_KEY_P1: 'p1', AWL_API_KEY_P3: 'p3', AWL_API_KEY: 'plain' })).toBe('p3');
            expect(netlifyAsync.apiKey({ AWL_API_KEY_P2: '  ', AWL_API_KEY: 'plain' })).toBe('plain');
            expect(netlifyAsync.apiKey({ AWL_API_KEY_PX: 'nope' })).toBe('');
        });
    });

    describe('validate', () => {
        it('accepts Netlify with a key', () => {
            expect(netlifyAsync.validate({ NETLIFY: 'true', AWL_API_KEY: KEY })).toEqual([]);
            expect(netlifyAsync.validate({ NETLIFY: 'true', AWL_API_KEY_P1: KEY })).toEqual([]);
        });

        it('refuses anywhere else, and names the other modes', () => {
            const [found] = netlifyAsync.validate({ AWL_API_KEY: KEY });
            expect(found.code).toBe('netlify_async_off_netlify');
            expect(found.fix).toContain('qstash');
        });

        it('says where the key comes from when it is missing', () => {
            const [found] = netlifyAsync.validate({ NETLIFY: 'true' });
            expect(found.code).toBe('missing_awl_api_key');
            expect(found.fix).toContain('Async Workloads');
        });
    });
});
