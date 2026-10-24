import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { assertEnvelope, bearer, call, client, mockRequests, postJson, resetMock } from '../lib/context.js';

beforeEach(resetMock);

function assertLimited(res) {
    assertEnvelope(res, 429, 'rate_limited');
    assert.match(res.headers.get('retry-after'), /^[1-9][0-9]?$/, 'an integer Retry-After of at least 1');
    assert.ok(Number(res.headers.get('retry-after')) <= 60);
}

describe('rate limits', () => {
    it('token route: 300 a minute per client IP, counted before authentication', async () => {
        const headers = client('198.51.100.71');
        for (let i = 0; i < 300; i++) {
            const res = await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, headers);
            assert.equal(res.status, 401, 'request ' + (i + 1));
        }
        assertLimited(await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, headers));
        const other = await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, client('198.51.100.72'));
        assert.equal(other.status, 401, 'another IP has its own counter');
    });

    it('token route: 30 a minute per user, and only requests that reach Drop Cowboy count', async () => {
        const user = crypto.randomUUID();
        const asUser = () => ({ ...client('10.88.' + crypto.randomInt(1, 255) + '.' + crypto.randomInt(1, 255)), 'x-test-user': user });
        for (let i = 0; i < 30; i++) {
            const res = await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, asUser());
            assert.equal(res.status, 200, 'request ' + (i + 1));
        }
        assertLimited(await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, asUser()));
        assert.equal((await mockRequests()).length, 30, 'the limited request never reached Drop Cowboy');

        const other = await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, { ...asUser(), 'x-test-user': crypto.randomUUID() });
        assert.equal(other.status, 200, 'another user has their own counter');
    });

    it('a request rejected for a bad purpose does not use up the per-user allowance', async () => {
        const user = crypto.randomUUID();
        for (let i = 0; i < 40; i++) {
            const res = await postJson('custom', '/api/dropcowboy/token', { purpose: 'nope' }, { ...client(), 'x-test-user': user });
            assert.equal(res.status, 400);
        }
        const ok = await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, { ...client(), 'x-test-user': user });
        assert.equal(ok.status, 200);
    });

    it('login mode: 30 a minute per access token', async () => {
        const send = () => postJson('limits-login', '/api/dropcowboy/token', { purpose: 'session' }, { ...bearer(), ...client() });
        for (let i = 0; i < 30; i++) {
            assert.equal((await send()).status, 200, 'request ' + (i + 1));
        }
        assertLimited(await send());
        const otherToken = await postJson('limits-login', '/api/dropcowboy/token', { purpose: 'session' }, { ...bearer('another-' + crypto.randomUUID()), ...client() });
        assertEnvelope(otherToken, 401, 'login_expired');
    });

    it('dev session: 10 a minute per client IP', async () => {
        const headers = client('198.51.100.61');
        for (let i = 0; i < 10; i++) {
            const res = await call('limits-dev', '/__dev/session', { headers });
            assertEnvelope(res, 404, 'session_not_found');
        }
        assertLimited(await call('limits-dev', '/__dev/session', { headers }));
        const other = await call('limits-dev', '/__dev/session', { headers: client('198.51.100.62') });
        assertEnvelope(other, 404, 'session_not_found');
    });

    it('DC_TRUST_PROXY=1 keys on the last X-Forwarded-For entry, so a spoofed left entry changes nothing', async () => {
        const send = (spoof) => call('limits-dev', '/__dev/session', { headers: { 'x-forwarded-for': spoof + ', 198.51.100.59' } });
        for (let i = 0; i < 10; i++) {
            assertEnvelope(await send('1.1.1.' + i), 404, 'session_not_found');
        }
        assertLimited(await send('1.1.1.200'));
    });

    it('DC_RATE_LIMIT=off never limits', async () => {
        for (let i = 0; i < 40; i++) {
            const res = await postJson('server', '/api/dropcowboy/token', { purpose: 'session' });
            assert.equal(res.status, 200);
        }
    });

    it('webhooks are never limited', async () => {
        for (let i = 0; i < 40; i++) {
            const res = await call('custom', '/webhooks/dropcowboy', { method: 'POST', body: '{}', headers: client('198.51.100.41') });
            assertEnvelope(res, 401, 'missing_signature');
        }
    });
});
