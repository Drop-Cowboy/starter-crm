import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertEnvelope, call } from '../lib/context.js';

const ALLOWED = 'https://crm.example.com';
const preflight = (mode, origin, extra = {}) => call(mode, '/api/dropcowboy/token', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type', ...extra }
});

describe('CORS', () => {
    it('is off by default: OPTIONS is a 404 and no CORS header is ever sent', async () => {
        const res = await preflight('server', ALLOWED);
        assertEnvelope(res, 404, 'not_found');
        const get = await call('server', '/api/config', { headers: { origin: ALLOWED } });
        assert.equal(get.headers.get('access-control-allow-origin'), null);
    });

    it('an allowlisted origin gets its own origin echoed with Vary and exposed headers', async () => {
        for (const origin of [ALLOWED, 'https://other.example.org']) {
            const res = await call('custom', '/api/config', { headers: { origin } });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('access-control-allow-origin'), origin);
            assert.match(res.headers.get('vary') || '', /origin/i);
            assert.equal(res.headers.get('access-control-expose-headers'), 'X-Request-Id, Retry-After');
            assert.equal(res.headers.get('access-control-allow-credentials'), null, 'cookies are never allowed cross-origin');
        }
    });

    it('an origin outside the list is served without CORS headers', async () => {
        const res = await call('custom', '/api/config', { headers: { origin: 'https://evil.example.net' } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    });

    it('a preflight from an allowlisted origin is 204 with the allowed methods and headers', async () => {
        const res = await preflight('custom', ALLOWED);
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
        assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
        assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, Last-Event-ID, X-Request-Id');
        assert.equal(res.headers.get('access-control-max-age'), '600');
        assert.ok(res.headers.get('x-request-id'));
    });

    it('a preflight from any other origin is 403 cors_rejected', async () => {
        const res = await preflight('custom', 'https://evil.example.net');
        assertEnvelope(res, 403, 'cors_rejected');
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    });

    it('OPTIONS without Access-Control-Request-Method is not a preflight', async () => {
        const res = await call('custom', '/api/config', { method: 'OPTIONS', headers: { origin: ALLOWED } });
        assertEnvelope(res, 404, 'not_found');
    });

    it('a mode with its own list honours it: the passcode server allows app.example.org only', async () => {
        const allowed = await call('passcode', '/api/config', { headers: { origin: 'https://app.example.org' } });
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.org');
        const other = await call('passcode', '/api/config', { headers: { origin: ALLOWED } });
        assert.equal(other.headers.get('access-control-allow-origin'), null);
    });
});
