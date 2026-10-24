import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { MOCK_TOKEN } from '../mock-upstream.js';
import { call, client, ctx, deliver, eventBody, postJson, resetMock, setCookies, sleep } from '../lib/context.js';

const MODE = 'passcode';
const ORIGIN = 'https://crm.example.com';
const readLines = (name) => {
    const file = path.join(ctx.servers[MODE].root, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
// Hooks and log writes finish before the response, but give a slow disk a moment.
async function waitFor(find) {
    for (let i = 0; i < 40; i++) {
        const found = find();
        if (found) return found;
        await sleep(50);
    }
    return undefined;
}

beforeEach(resetMock);

describe('logging', () => {
    it('writes one redacted access line per request to the configured sink', async () => {
        const id = 'log-' + crypto.randomUUID();
        const res = await call(MODE, '/api/nope/+13125550142/jane.doe@example.com', { headers: { 'x-request-id': id, ...client('203.0.113.131') } });
        assert.equal(res.status, 404);
        const line = await waitFor(() => readLines('log.jsonl').find((r) => r.request_id === id));
        assert.ok(line, 'an access line for the request');
        assert.equal(line.level, 'info');
        assert.equal(typeof line.message, 'string');
        assert.ok(!Number.isNaN(Date.parse(line.time)), 'time is an ISO timestamp');
        assert.equal(line.method, 'GET');
        assert.equal(line.status, 404);
        assert.equal(typeof line.duration_ms, 'number');
        assert.ok(line.path.includes('[redacted-phone]'), line.path);
        assert.ok(line.path.includes('[redacted-email]'), line.path);
        assert.ok(!/13125550142|jane\.doe@/.test(JSON.stringify(line)), 'no phone number or email survives: ' + JSON.stringify(line));
    });

    it('never logs the query string', async () => {
        const id = 'log-' + crypto.randomUUID();
        await call(MODE, '/healthz?token=' + MOCK_TOKEN, { headers: { 'x-request-id': id } });
        const line = await waitFor(() => readLines('log.jsonl').find((r) => r.request_id === id));
        assert.equal(line.path, '/healthz');
    });

    it('keeps secrets, tokens and the passcode out of the sink', async () => {
        const mint = await postJson(MODE, '/api/auth/passcode', { passcode: ctx.secrets.passcode }, { origin: ORIGIN, ...client('203.0.113.132') });
        assert.equal(mint.status, 200);
        await postJson(MODE, '/api/auth/passcode', { passcode: 'wrong-passcode-value' }, { origin: ORIGIN, ...client('203.0.113.132') });
        const text = fs.readFileSync(path.join(ctx.servers[MODE].root, 'log.jsonl'), 'utf8');
        for (const secret of [ctx.secrets.passcode, ctx.secrets.apiKey, ctx.secrets.apiSecret, ctx.secrets.webhookSecret, MOCK_TOKEN, 'wrong-passcode-value']) {
            assert.ok(!text.includes(secret), 'the log sink contains a secret');
        }
        const cookie = setCookies(mint)[0].split(';')[0].split('=')[1];
        assert.ok(!text.includes(cookie), 'the session cookie value must not be logged');
    });
});

describe('observer hooks', () => {
    it('onRequest and onResponse fire for every request with the documented payloads', async () => {
        const id = 'obs-' + crypto.randomUUID();
        await call(MODE, '/healthz', { headers: { 'x-request-id': id, 'x-forwarded-for': '203.0.113.147' } });
        const req = await waitFor(() => readLines('observer.jsonl').find((r) => r.hook === 'onRequest' && r.payload.request_id === id));
        const res = await waitFor(() => readLines('observer.jsonl').find((r) => r.hook === 'onResponse' && r.payload.request_id === id));
        assert.deepEqual(req.payload, { request_id: id, method: 'GET', path: '/healthz', client_ip: '203.0.113.147' });
        assert.deepEqual(Object.keys(res.payload).sort(), ['duration_ms', 'method', 'path', 'request_id', 'status']);
        assert.equal(res.payload.status, 200);
        assert.equal(typeof res.payload.duration_ms, 'number');
    });

    it('onWebhook fires for each verified delivery, flags a duplicate, and a throwing hook changes nothing', async () => {
        const eventId = crypto.randomUUID();
        const body = eventBody(eventId);
        const first = await deliver(MODE, body, { headers: client('203.0.113.148') });
        assert.equal(first.status, 200, 'the hook throws, the response must not');
        const second = await deliver(MODE, body, { headers: client('203.0.113.148') });
        assert.equal(second.status, 200);
        const seen = await waitFor(() => {
            const hooks = readLines('observer.jsonl').filter((r) => r.hook === 'onWebhook' && r.payload.event_id === eventId);
            return hooks.length >= 2 ? hooks : null;
        });
        assert.ok(seen, 'both deliveries reported');
        assert.deepEqual(seen.map((r) => r.payload.duplicate), [false, true]);
        assert.equal(seen[0].payload.event, 'contact.msg.received');
        assert.ok(seen[0].payload.request_id);
        const failure = await waitFor(() => readLines('log.jsonl').find((r) => r.level === 'warn' && /onWebhook/.test(r.message)));
        assert.ok(failure, 'a failing hook is logged as a warning');
    });

    it('onTokenMinted reports a fresh mint, then a cache hit, and never carries the token', async () => {
        const signIn = await postJson(MODE, '/api/auth/passcode', { passcode: ctx.secrets.passcode }, { origin: ORIGIN, ...client('203.0.113.149') });
        const cookie = setCookies(signIn)[0].split(';')[0];
        const send = () => postJson(MODE, '/api/dropcowboy/token', { purpose: 'campaigns' }, { cookie, origin: ORIGIN, ...client('203.0.113.149') });
        const first = await send();
        const second = await send();
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        const hooks = await waitFor(() => {
            const found = readLines('observer.jsonl').filter((r) => r.hook === 'onTokenMinted' && r.payload.purpose === 'campaigns');
            return found.length >= 2 ? found : null;
        });
        assert.ok(hooks);
        assert.deepEqual(hooks.map((r) => r.payload.cached), [false, true]);
        assert.deepEqual(Object.keys(hooks[0].payload).sort(), ['cached', 'expires_at', 'purpose', 'request_id', 'user_id']);
        assert.equal(typeof hooks[0].payload.expires_at, 'number');
        assert.ok(!JSON.stringify(hooks).includes(MOCK_TOKEN));
    });
});
