import { afterEach, describe, expect, it } from 'vitest';
import { fromUpstream, upstreamCode } from '../src/errors.js';
import { fakeFetch, jsonResponse, makeConfig, startApp } from './helpers.js';

const CANARY = 'RAW-UPSTREAM-CANARY';

describe('upstreamCode', () => {
    it('prefers detail.code, then details.code, code, error, then the type slug', () => {
        expect(upstreamCode(403, { message: 'm', detail: { code: 'consent_required' } })).toBe('consent_required');
        expect(upstreamCode(403, { details: { code: 'byoc_required' } })).toBe('byoc_required');
        expect(upstreamCode(400, { code: 'invalid_site_id' })).toBe('invalid_site_id');
        expect(upstreamCode(400, { error: 'invalid_request' })).toBe('invalid_request');
        expect(upstreamCode(402, { type: 'https://api-v2.dropcowboy.com/errors/payment-required', detail: 'Add funds.' })).toBe('payment-required');
        expect(upstreamCode(403, { type: 'https://api-v2.dropcowboy.com/errors/insufficient-scope' })).toBe('insufficient-scope');
    });

    it('falls back to a code for the status', () => {
        expect(upstreamCode(402, null)).toBe('payment-required');
        expect(upstreamCode(403, {})).toBe('forbidden');
        expect(upstreamCode(429, 'text')).toBe('too-many-requests');
        expect(upstreamCode(418, {})).toBe('bad-request');
    });
});

describe('fromUpstream', () => {
    const headers = new Headers({ 'retry-after': '7' });

    it('keeps the status and code of a 4xx, and a short message', () => {
        const err = fromUpstream(403, { message: 'A valid consent_id is required', detail: { code: 'consent_required' }, debug: CANARY }, headers);
        expect([err.status, err.code, err.message]).toEqual([403, 'consent_required', 'A valid consent_id is required']);
        expect(JSON.stringify(err)).not.toContain(CANARY);
    });

    it('turns a 401 into 502 upstream_auth_failed, since the server key is wrong', () => {
        const err = fromUpstream(401, { type: 'https://api-v2.dropcowboy.com/errors/unauthorized' }, headers);
        expect([err.status, err.code]).toEqual([502, 'upstream_auth_failed']);
    });

    it('never passes a 5xx message through', () => {
        const err = fromUpstream(500, { detail: CANARY }, headers);
        expect([err.status, err.code]).toEqual([502, 'upstream_error']);
        expect(err.message).not.toContain(CANARY);
    });

    it('copies Retry-After on 429 only', () => {
        expect(fromUpstream(429, {}, headers).headers).toEqual({ 'Retry-After': '7' });
        expect(fromUpstream(403, {}, headers).headers).toEqual({});
    });

    it('caps long messages at 300 characters', () => {
        expect(fromUpstream(400, { detail: 'x'.repeat(1000) }, headers).message).toHaveLength(300);
    });
});

describe('error envelope on the wire', () => {
    let app;
    afterEach(() => app && app.close());

    async function mint(fetchImpl, config = makeConfig()) {
        app = await startApp(config, { fetch: fetchImpl });
        const res = await fetch(app.url + '/api/dropcowboy/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"purpose":"session"}'
        });
        return { status: res.status, body: await res.json() };
    }

    it('passes 402 payment-required through', async () => {
        const { status, body } = await mint(fakeFetch(() => jsonResponse(402, {
            type: 'https://api-v2.dropcowboy.com/errors/payment-required', title: 'Payment Required', status: 402, detail: 'Add funds to continue.', instance: CANARY
        })));
        expect(status).toBe(402);
        expect(body).toEqual({ error: { code: 'payment-required', message: 'Add funds to continue.' } });
    });

    it('maps a timeout to 504 upstream_timeout', async () => {
        const hang = (url, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
        const { status, body } = await mint(hang, makeConfig({ DROPCOWBOY_TIMEOUT_MS: '50' }));
        expect(status).toBe(504);
        expect(body.error.code).toBe('upstream_timeout');
    });

    it('maps a connection failure to 502 upstream_unreachable', async () => {
        const { status, body } = await mint(async () => { throw new TypeError('fetch failed'); });
        expect(status).toBe(502);
        expect(body.error.code).toBe('upstream_unreachable');
    });

    it('maps a non-JSON upstream error to 502 upstream_error', async () => {
        const { status, body } = await mint(async () => new Response('<html>' + CANARY + '</html>', { status: 502 }));
        expect(status).toBe(502);
        expect(body.error.code).toBe('upstream_error');
        expect(JSON.stringify(body)).not.toContain(CANARY);
    });

    it('wraps unknown routes in the envelope', async () => {
        app = await startApp(makeConfig());
        const res = await fetch(app.url + '/api/nothing-here?x=1');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'No route matches GET /api/nothing-here.' } });
    });
});
