import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { assertEnvelope, ctx, deliver, eventBody, nowSeconds, signature } from '../lib/context.js';

describe('POST /webhooks/dropcowboy', () => {
    it('accepts a correctly signed delivery', async () => {
        const res = await deliver('login', eventBody(crypto.randomUUID()), { headers: { 'x-event-id': null } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { received: true });
    });

    it('accepts a delivery signed with any configured secret (one per subscription)', async () => {
        const res = await deliver('login', eventBody(crypto.randomUUID()), { secret: ctx.secrets.webhookSecret2 });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { received: true });
    });

    it('is registered in server mode too', async () => {
        const res = await deliver('server', eventBody(crypto.randomUUID()));
        assert.equal(res.status, 200);
    });

    it('verifies the raw bytes, so unusual spacing and key order still verify', async () => {
        const raw = '{\n  "data" : { "b": 2, "a": 1 },\n  "event":"contact.msg.received" ,"event_id": "' + crypto.randomUUID() + '"\n}';
        const res = await deliver('login', raw);
        assert.equal(res.status, 200);
    });

    it('accepts any Content-Type', async () => {
        const res = await deliver('login', eventBody(crypto.randomUUID()), { headers: { 'content-type': 'text/plain' } });
        assert.equal(res.status, 200);
    });

    it('acknowledges a replayed X-Event-Id as a duplicate', async () => {
        const eventId = crypto.randomUUID();
        const body = eventBody(eventId);
        const first = await deliver('login', body, { headers: { 'x-event-id': eventId } });
        const second = await deliver('login', body, { headers: { 'x-event-id': eventId, 'x-attempt': '2' } });
        assert.deepEqual(first.body, { received: true });
        assert.equal(second.status, 200);
        assert.deepEqual(second.body, { received: true, duplicate: true });
    });

    it('falls back to the body event_id for de-duplication', async () => {
        const body = eventBody(crypto.randomUUID());
        await deliver('login', body, { headers: { 'x-event-id': null } });
        const again = await deliver('login', body, { headers: { 'x-event-id': null } });
        assert.deepEqual(again.body, { received: true, duplicate: true });
    });

    it('401 invalid_signature for the wrong secret', async () => {
        const res = await deliver('login', eventBody(crypto.randomUUID()), { secret: 'not-the-signing-secret' });
        assertEnvelope(res, 401, 'invalid_signature');
    });

    it('401 invalid_signature when the body was changed after signing', async () => {
        const body = eventBody(crypto.randomUUID());
        const timestamp = String(nowSeconds());
        const good = signature(body, ctx.secrets.webhookSecret, timestamp);
        const res = await deliver('login', body.replace('Yes', 'No!'), { timestamp, headers: { 'x-signature': good } });
        assertEnvelope(res, 401, 'invalid_signature');
    });

    it('401 invalid_signature for an unknown X-Signature-Version', async () => {
        const res = await deliver('login', eventBody(crypto.randomUUID()), { headers: { 'x-signature-version': 'v2' } });
        assertEnvelope(res, 401, 'invalid_signature');
    });

    it('401 invalid_signature for a signature without the sha256= prefix', async () => {
        const body = eventBody(crypto.randomUUID());
        const timestamp = String(nowSeconds());
        const signed = signature(body, ctx.secrets.webhookSecret, timestamp);
        const res = await deliver('login', body, { timestamp, headers: { 'x-signature': signed.slice('sha256='.length) } });
        assertEnvelope(res, 401, 'invalid_signature');
    });

    for (const header of ['x-signature', 'x-timestamp']) {
        it('401 missing_signature without ' + header, async () => {
            const res = await deliver('login', eventBody(crypto.randomUUID()), { headers: { [header]: null } });
            assertEnvelope(res, 401, 'missing_signature');
        });
    }

    const stale = [
        ['301 s old', () => String(nowSeconds() - 301)],
        ['301 s in the future', () => String(nowSeconds() + 301)],
        ['in milliseconds', () => String(Date.now())],
        ['not a number', () => 'yesterday'],
        ['fractional', () => nowSeconds() + '.5']
    ];
    for (const [label, timestamp] of stale) {
        it('401 stale_timestamp for a timestamp ' + label, async () => {
            const res = await deliver('login', eventBody(crypto.randomUUID()), { timestamp: timestamp() });
            assertEnvelope(res, 401, 'stale_timestamp');
        });
    }

    it('400 invalid_json for a correctly signed body that is not JSON', async () => {
        const res = await deliver('login', 'event=contact.msg.received');
        assertEnvelope(res, 400, 'invalid_json');
    });

    it('503 webhook_not_configured when DROPCOWBOY_WEBHOOK_SECRET is unset', async () => {
        const res = await deliver('mcp-session', eventBody(crypto.randomUUID()));
        assertEnvelope(res, 503, 'webhook_not_configured');
    });
});
