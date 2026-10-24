// The `vercel-queue` webhook mode against a stand-in for @vercel/queue: Vercel Queues itself only exists on Vercel,
// so the real thing is proved by the sandbox deploy (npm run test:deployed). Here the dispatcher and its consumer
// route are driven with a fake SDK that delivers a message the way Vercel does, as a POST to the consumer route.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import { createProcessor } from '../src/processor.js';
import { createRuntime } from '../src/runtime.js';
import * as localFanout from '../src/providers/fanout/local.js';
import * as memoryStore from '../src/providers/store/memory.js';
import * as vercelQueue from '../src/providers/webhooks/vercel-queue.js';
import { makeConfig, silentLog } from './helpers.js';

/**
 * A fake of the two functions the mode uses. `send` records messages; `handleCallback` returns a route handler that
 * does what the real one does: parse the message, call the consumer, answer 200, or answer 500 with the retry delay
 * the `retry` option chose when the consumer throws.
 *
 * @returns {{ send: Function, handleCallback: Function, sent: object[] }} The fake SDK.
 */
function fakeSdk() {
    const sent = [];
    return {
        sent,
        send: async (topic, payload, options) => {
            sent.push({ topic, payload, options });
            return { messageId: crypto.randomUUID() };
        },
        handleCallback: (consume, options) => async (request) => {
            const message = await request.json();
            const deliveryCount = Number(request.headers.get('x-delivery-count') || '1');
            try {
                await consume(message, { deliveryCount });
                return new Response(null, { status: 200 });
            } catch (error) {
                const directive = options.retry(error, { deliveryCount });
                return new Response(JSON.stringify(directive), { status: 500 });
            }
        }
    };
}

async function build({ handlers = {}, maxAttempts = 3 } = {}) {
    const config = makeConfig({ DC_STORE: 'sqlite', DC_SQLITE_PATH: ':memory:', DC_WEBHOOKS: 'inline', DC_WEBHOOK_MAX_ATTEMPTS: String(maxAttempts) });
    const store = memoryStore.create({ config });
    const fanout = localFanout.create();
    const processor = createProcessor({ config, store, fanout, handlers, log: silentLog });
    const sdk = fakeSdk();
    const dispatcher = await vercelQueue.create({ config, processor, log: silentLog, sdk });
    const runtime = createRuntime({ config, store, fanout, dispatcher, processor, log: silentLog });
    const core = createCore(config, { log: silentLog, runtime });
    return { config, store, processor, dispatcher, sdk, core };
}

async function record(store, event = 'contact.rvm.status') {
    const eventId = crypto.randomUUID();
    await store.record({ event_id: eventId, event, event_at: null, received_at: Date.now(), attempt: 1, data: {} }, { visibleAt: 0 });
    return eventId;
}

function deliver(core, message, deliveryCount = 1) {
    return core.handle(new Request('https://crm.example.test' + vercelQueue.CONSUMER_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-delivery-count': String(deliveryCount) },
        body: JSON.stringify(message)
    }));
}

describe('webhooks: vercel-queue', () => {
    it('sends only the event id and the site to the topic, and says it queued', async () => {
        const { dispatcher, sdk, config } = await build();
        const id = crypto.randomUUID();
        expect(await dispatcher.dispatch(id)).toEqual({ outcome: 'queued' });
        expect(sdk.sent).toEqual([{ topic: vercelQueue.TOPIC, payload: { event_id: id, site_id: config.siteId }, options: undefined }]);
    });

    it('lets a failed send reach the webhook, so it answers 503 and Drop Cowboy retries', async () => {
        const { dispatcher, sdk } = await build();
        sdk.send = async () => { throw new Error('queue unavailable'); };
        await expect(dispatcher.dispatch(crypto.randomUUID())).rejects.toThrow('queue unavailable');
    });

    it('processes the event when the queue delivers it, and finishes it', async () => {
        const seen = [];
        const { core, store } = await build({ handlers: { 'contact.rvm.status': async (event) => { seen.push(event.event_id); } } });
        const id = await record(store);
        const response = await deliver(core, { event_id: id });
        expect(response.status).toBe(200);
        expect(seen).toEqual([id]);
        expect((await store.get(id)).status).toBe('processed');
    });

    it('is safe when the queue delivers a message twice', async () => {
        const seen = [];
        const { core, store } = await build({ handlers: { 'contact.rvm.status': async (event) => { seen.push(event.event_id); } } });
        const id = await record(store);
        await deliver(core, { event_id: id });
        expect((await deliver(core, { event_id: id }, 2)).status).toBe(200);
        expect(seen).toHaveLength(1);
    });

    it('fails the delivery with the backoff as the retry delay when a handler fails, then gives up after the attempts', async () => {
        const { core, store } = await build({ maxAttempts: 2, handlers: { 'contact.rvm.status': async () => { throw new Error('boom'); } } });
        const id = await record(store);
        const first = await deliver(core, { event_id: id }, 1);
        expect(first.status).toBe(500);
        expect(JSON.parse(await first.text())).toEqual({ afterSeconds: 1 });
        expect((await store.get(id)).status).toBe('received');
        const second = await deliver(core, { event_id: id }, 2);
        expect(second.status).toBe(200);
        expect((await store.get(id)).status).toBe('failed');
    });

    it('doubles the retry delay each delivery and caps it at five minutes', () => {
        expect([1, 2, 3, 4].map(vercelQueue.retryAfterSeconds)).toEqual([1, 2, 4, 8]);
        expect(vercelQueue.retryAfterSeconds(30)).toBe(300);
        expect(vercelQueue.retryAfterSeconds(0)).toBe(1);
    });

    it('drops a message that is not an event id instead of retrying it forever', async () => {
        const { core } = await build();
        for (const message of [{}, { event_id: 42 }, null, 'text']) {
            expect((await deliver(core, message)).status).toBe(200);
        }
    });

    it('registers one POST route and nothing runs in the background', async () => {
        const { dispatcher } = await build();
        expect(dispatcher.routes().map((route) => route.method + ' ' + route.path)).toEqual(['POST /internal/queue/webhook-jobs']);
        await dispatcher.start();
        await dispatcher.stop();
        expect(await dispatcher.ready()).toBe(true);
    });

    it('re-queues events by sending them again', async () => {
        const { dispatcher, sdk } = await build();
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        await dispatcher.sweep(ids);
        expect(sdk.sent.map((item) => item.payload.event_id)).toEqual(ids);
    });

    describe('validate', () => {
        it('accepts Vercel, and an environment pulled with `vercel env pull`', () => {
            expect(vercelQueue.validate({ VERCEL: '1' })).toEqual([]);
            expect(vercelQueue.validate({ VERCEL_OIDC_TOKEN: 'token-from-env-pull' })).toEqual([]);
        });

        it('refuses anywhere else, and names the other modes', () => {
            const [found] = vercelQueue.validate({});
            expect(found.code).toBe('vercel_queue_off_vercel');
            expect(found.fix).toContain('qstash');
        });
    });
});
