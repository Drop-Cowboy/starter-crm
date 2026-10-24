import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { assertEnvelope, call, ctx, UUID } from '../lib/context.js';

const MODES = ['login', 'server', 'mcp-session', 'custom', 'passcode', 'oidc'];

describe('request ids', () => {
    for (const mode of MODES) {
        it(mode + ': a valid X-Request-Id is echoed on success, errors and static files', async () => {
            for (const path of ['/healthz', '/api/config', '/api/nope', '/shared/nope.js', '/']) {
                const id = 'req-' + crypto.randomUUID();
                const res = await call(mode, path, { headers: { 'x-request-id': id } });
                assert.equal(res.headers.get('x-request-id'), id, path);
            }
        });

        it(mode + ': a missing X-Request-Id is replaced by a UUID v4', async () => {
            const res = await call(mode, '/healthz');
            assert.match(res.headers.get('x-request-id'), UUID);
            assert.equal(res.headers.get('x-request-id')[14], '4', 'version 4');
        });
    }

    it('an unusable X-Request-Id is replaced, never echoed', async () => {
        for (const bad of ['has space', 'x'.repeat(65), 'semi;colon', 'quo"te']) {
            const res = await call('server', '/healthz', { headers: { 'x-request-id': bad } });
            assert.notEqual(res.headers.get('x-request-id'), bad);
            assert.match(res.headers.get('x-request-id'), UUID);
        }
    });

    it('a 64 character id is kept', async () => {
        const id = 'a'.repeat(64);
        const res = await call('server', '/healthz', { headers: { 'x-request-id': id } });
        assert.equal(res.headers.get('x-request-id'), id);
    });

    it('every error envelope carries the request id', async () => {
        const id = 'envelope-' + crypto.randomUUID();
        const res = await call('server', '/api/nope', { headers: { 'x-request-id': id } });
        assertEnvelope(res, 404, 'not_found');
        assert.equal(res.body.error.request_id, id);
    });
});

describe('response headers', () => {
    for (const mode of MODES) {
        it(mode + ': the fixed security headers are on every kind of response', async () => {
            for (const path of ['/healthz', '/api/config', '/api/nope', '/']) {
                const res = await call(mode, path);
                const h = (name) => res.headers.get(name);
                assert.equal(h('x-content-type-options'), 'nosniff', path);
                assert.equal(h('referrer-policy'), 'no-referrer', path);
                assert.equal(h('cross-origin-opener-policy'), 'same-origin', path);
                assert.equal(h('permissions-policy'), 'microphone=(self), camera=(), geolocation=()', path);
                assert.equal(h('x-frame-options'), 'DENY', path);
            }
        });
    }

    it('the default CSP is report-only, keeps frame-ancestors none and names only public origins', async () => {
        const res = await call('server', '/api/config');
        const csp = res.headers.get('content-security-policy-report-only');
        assert.ok(csp, 'a report-only policy');
        assert.equal(res.headers.get('content-security-policy'), null);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /object-src 'none'/);
        assert.match(csp, /https:\/\/webforms\.dropcowboy\.com/);
        assert.match(csp, /https:\/\/app-api-v2\.dropcowboy\.com/);
        assert.ok(!/localhost|127\.0\.0\.1|\*/.test(csp), 'no wildcard or private origin: ' + csp);
    });

    it('DC_CSP=enforce sends the enforcing header instead', async () => {
        const res = await call('custom', '/api/config');
        assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.equal(res.headers.get('content-security-policy-report-only'), null);
    });

    it('HSTS is sent only in production, without includeSubDomains', async () => {
        const production = await call('passcode', '/healthz');
        assert.equal(production.headers.get('strict-transport-security'), 'max-age=31536000');
        const development = await call('server', '/healthz');
        assert.equal(development.headers.get('strict-transport-security'), null);
    });

    it('the headers are also on error responses from other routes', async () => {
        const res = await call('passcode', '/api/dropcowboy/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assertEnvelope(res, 401, 'unauthenticated');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
    });

    it('uses the mode names the harness started', () => {
        for (const mode of MODES) assert.ok(ctx.servers[mode], mode);
    });
});
