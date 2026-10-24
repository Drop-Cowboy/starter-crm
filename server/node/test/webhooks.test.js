import { afterEach, describe, expect, it } from 'vitest';
import { verifySignature } from '../src/webhooks.js';
import { defaultRuntime } from '../src/runtime.js';
import { WEBHOOK_SECRET, makeConfig, sign, silentLog, startApp } from './helpers.js';

const NOW = 1790000000;
const BODY = '{"event_id":"d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c","event":"contact.rvm.status","data":{}}';

function check(overrides = {}) {
    const timestamp = String(NOW);
    return verifySignature({
        rawBody: Buffer.from(BODY),
        signature: sign(BODY, WEBHOOK_SECRET, timestamp),
        timestamp,
        version: 'v1',
        secrets: [WEBHOOK_SECRET],
        nowSeconds: NOW,
        ...overrides
    });
}

describe('verifySignature', () => {
    it('accepts a valid signature', () => {
        expect(check()).toEqual({ ok: true });
    });

    it('accepts a signature from any configured secret, one per subscription', () => {
        expect(check({ secrets: ['secret-for-another-event', WEBHOOK_SECRET] })).toEqual({ ok: true });
        expect(check({ secrets: ['secret-for-another-event'] }).code).toBe('invalid_signature');
        expect(check({ secrets: [] }).code).toBe('invalid_signature');
    });

    it('rejects a signature made with another secret', () => {
        expect(check({ signature: sign(BODY, 'another-secret', String(NOW)) }).code).toBe('invalid_signature');
    });

    it('rejects a changed body', () => {
        expect(check({ rawBody: Buffer.from(BODY.replace('rvm', 'sms')) }).code).toBe('invalid_signature');
    });

    it('rejects timestamps more than 5 minutes old or ahead', () => {
        expect(check({ nowSeconds: NOW + 300 }).ok).toBe(true);
        expect(check({ nowSeconds: NOW + 301 }).code).toBe('stale_timestamp');
        expect(check({ nowSeconds: NOW - 301 }).code).toBe('stale_timestamp');
    });

    it('rejects malformed timestamps, missing headers and unknown versions', () => {
        expect(check({ timestamp: '1790000000.5' }).code).toBe('stale_timestamp');
        expect(check({ signature: undefined }).code).toBe('missing_signature');
        expect(check({ timestamp: '' }).code).toBe('missing_signature');
        expect(check({ version: 'v2' }).code).toBe('invalid_signature');
        expect(check({ version: undefined }).ok).toBe(true);
    });

    it('rejects a signature of the wrong length without throwing', () => {
        expect(check({ signature: 'sha256=abc' }).code).toBe('invalid_signature');
    });
});

describe('POST /webhooks/dropcowboy', () => {
    let app;
    afterEach(() => app && app.close());

    function deliver(body, { eventId, secret = WEBHOOK_SECRET, timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
        return fetch(app.url + '/webhooks/dropcowboy', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-signature': sign(body, secret, timestamp),
                'x-timestamp': timestamp,
                'x-signature-version': 'v1',
                'x-event-id': eventId || '',
                'x-attempt': '1'
            },
            body
        });
    }

    it('verifies the raw bytes, not re-serialised JSON', async () => {
        app = await startApp(makeConfig());
        const spaced = '{ "event_id" : "a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b",\n  "event": "contact.msg.received", "data": {} }';
        const res = await deliver(spaced);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ received: true });
    });

    it('acknowledges a replayed event id without running its handlers twice', async () => {
        const ran = [];
        const config = makeConfig();
        const runtime = defaultRuntime(config, silentLog, { handlers: { '*': async (event) => ran.push(event.event_id) } });
        app = await startApp(config, { runtime });

        const eventId = 'b3e7a1c9-8d5f-4b2e-9a6c-1f4d7b3e8a52';
        const first = await deliver(BODY, { eventId });
        const second = await deliver(BODY, { eventId });

        expect(await first.json()).toEqual({ received: true });
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({ received: true, duplicate: true });
        expect(ran).toEqual([eventId]);
        expect((await runtime.store.counts()).processed).toBe(1);
    });

    it('answers 503 so Drop Cowboy retries when an inline handler fails', async () => {
        const config = makeConfig();
        const runtime = defaultRuntime(config, silentLog, { handlers: { '*': async () => { throw new Error('crm is down'); } } });
        app = await startApp(config, { runtime });
        const res = await deliver(BODY, { eventId: 'c4f8b2d0-9e6a-4c3f-8b7d-2a5e8c4f9b63' });
        expect(res.status).toBe(503);
    });

    it('answers 503 when the event cannot be recorded', async () => {
        const config = makeConfig();
        const runtime = defaultRuntime(config, silentLog);
        runtime.store.record = async () => { throw new Error('store is down'); };
        app = await startApp(config, { runtime });
        const res = await deliver(BODY, { eventId: 'd5a9c3e1-af7b-4d40-9c8e-3b6f9d5a0c74' });
        expect(res.status).toBe(503);
    });

    it('verifies against every secret in a comma-separated DROPCOWBOY_WEBHOOK_SECRET', async () => {
        app = await startApp(makeConfig({ DROPCOWBOY_WEBHOOK_SECRET: 'first-subscription-secret , ' + WEBHOOK_SECRET }));
        expect((await deliver(BODY, { secret: 'first-subscription-secret', eventId: 'e1' })).status).toBe(200);
        expect((await deliver(BODY, { secret: WEBHOOK_SECRET, eventId: 'e2' })).status).toBe(200);
        expect((await deliver(BODY, { secret: 'first-subscription-secret ', eventId: 'e3' })).status).toBe(401);
    });

    it('answers 401 invalid_signature for the wrong secret', async () => {
        app = await startApp(makeConfig());
        const res = await deliver(BODY, { secret: 'wrong-secret' });
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('invalid_signature');
    });

    it('answers 401 stale_timestamp for an old delivery', async () => {
        app = await startApp(makeConfig());
        const res = await deliver(BODY, { timestamp: String(Math.floor(Date.now() / 1000) - 600) });
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('stale_timestamp');
    });

    it('answers 503 when no webhook secret is configured', async () => {
        app = await startApp(makeConfig({ DROPCOWBOY_WEBHOOK_SECRET: '' }));
        const res = await deliver(BODY);
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('webhook_not_configured');
    });

    it('GET /api/webhooks/status counts events by state', async () => {
        const config = makeConfig();
        const runtime = defaultRuntime(config, silentLog);
        app = await startApp(config, { runtime });
        await deliver(BODY, { eventId: 'f7cbe5a3-c19d-4f62-9eaf-5d8b1f7c2e96' });
        const failedId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
        await runtime.store.record({ event_id: failedId, event: 'contact.msg.received', event_at: null, received_at: Date.now(), attempt: 1, data: {} });
        await runtime.store.markFailed(failedId, 'crm is down');

        const res = await fetch(app.url + '/api/webhooks/status');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            store: 'memory', webhooks: 'store', max_attempts: 8, received: 0, processed: 1, failed: 1, oldest_received_age_seconds: 0
        });
    });

    it('GET /api/webhooks/status answers 503 when the store cannot be read', async () => {
        const config = makeConfig();
        const runtime = defaultRuntime(config, silentLog);
        runtime.store.counts = async () => { throw new Error('store is down'); };
        app = await startApp(config, { runtime });
        const res = await fetch(app.url + '/api/webhooks/status');
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('event_store_unavailable');
    });
});
