import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { assertEnvelope, bearer, call, ctx, mockRequests, mockScenario, postJson, resetMock } from '../lib/context.js';
import { startIssuer } from '../lib/jwks.js';

let issuer;
before(async () => {
    issuer = await startIssuer(ctx.oidc.port, ctx.oidc.audience);
});
after(async () => {
    await issuer.close().catch(() => {});
});
beforeEach(resetMock);

// The oidc server has the token cache on, and every token carries its own user.
const mintAs = (sub, purpose = 'session') => postJson('oidc', '/api/dropcowboy/token', { purpose }, { authorization: 'Bearer ' + issuer.token({ claims: { sub } }) });

describe('token cache (server mode, DC_TOKEN_CACHE=on)', () => {
    it('serves the same user and purpose from memory while the token has more than 60 s left', async () => {
        const sub = crypto.randomUUID();
        const first = await mintAs(sub);
        const second = await mintAs(sub);
        assert.equal(first.status, 200);
        assert.deepEqual(second.body, first.body);
        assert.equal((await mockRequests()).length, 1, 'one upstream mint');
    });

    it('keeps a cache entry per purpose and per user', async () => {
        const sub = crypto.randomUUID();
        await mintAs(sub, 'session');
        await mintAs(sub, 'contacts');
        await mintAs(crypto.randomUUID(), 'session');
        assert.equal((await mockRequests()).length, 3);
    });

    it('never caches a token that expires inside the 60 s margin', async () => {
        await mockScenario('token', 'short_lived');
        const sub = crypto.randomUUID();
        await mintAs(sub);
        await mintAs(sub);
        assert.equal((await mockRequests()).length, 2);
    });

    it('does not cache failures', async () => {
        const sub = crypto.randomUUID();
        await mockScenario('token', 'payment_required');
        assertEnvelope(await mintAs(sub), 402, 'payment-required');
        await mockScenario('token', 'success');
        assert.equal((await mintAs(sub)).status, 200);
        assert.equal((await mockRequests()).length, 2);
    });

    it('a cache hit still returns the documented body', async () => {
        const sub = crypto.randomUUID();
        await mintAs(sub);
        const hit = await mintAs(sub);
        assert.deepEqual(Object.keys(hit.body).sort(), ['expires_at', 'token']);
    });
});

describe('careful upstream calls', () => {
    const readiness = (mode = 'server') => call(mode, '/api/dropcowboy/readiness', { headers: mode === 'login' ? bearer() : {} });
    const mint = () => postJson('server', '/api/dropcowboy/token', { purpose: 'session' });

    it('retries a read once after a 5xx and returns the second answer', async () => {
        await mockScenario('readiness', 'flaky');
        const res = await readiness();
        assert.equal(res.status, 200);
        assert.equal((await mockRequests()).length, 2);
    });

    it('login mode retries reads too', async () => {
        await mockScenario('readiness', 'flaky');
        const res = await readiness('login');
        assert.equal(res.status, 200);
        assert.equal((await mockRequests()).length, 2);
    });

    it('honours a short Retry-After on 429 before retrying a read', async () => {
        await mockScenario('readiness', 'flaky_429');
        const started = Date.now();
        const res = await readiness();
        assert.equal(res.status, 200);
        assert.ok(Date.now() - started >= 900, 'waited about Retry-After: 1');
        assert.equal((await mockRequests()).length, 2);
    });

    it('gives up after 3 attempts in total', async () => {
        await mockScenario('readiness', 'server_error');
        const res = await readiness();
        assertEnvelope(res, 502, 'upstream_error');
        assert.equal((await mockRequests()).length, 3);
    });

    it('does not retry a long Retry-After, and passes the 429 through', async () => {
        await mockScenario('readiness', 'rate_limited');
        const res = await readiness();
        assertEnvelope(res, 429, 'too-many-requests');
        assert.equal(res.headers.get('retry-after'), '7');
        assert.equal((await mockRequests()).length, 1);
    });

    it('does not retry a 4xx', async () => {
        await mockScenario('readiness', 'unauthorized');
        assertEnvelope(await readiness(), 502, 'upstream_auth_failed');
        assert.equal((await mockRequests()).length, 1);
    });

    it('does not retry a timeout', async () => {
        await mockScenario('readiness', 'slow');
        assertEnvelope(await readiness(), 504, 'upstream_timeout');
        assert.equal((await mockRequests()).length, 1);
    });

    it('never retries a mint, after a 5xx or a throttle', async () => {
        await mockScenario('token', 'flaky');
        assertEnvelope(await mint(), 502, 'upstream_error');
        assert.equal((await mockRequests()).length, 1);

        await resetMock();
        await mockScenario('token', 'flaky_429');
        assertEnvelope(await mint(), 429, 'too-many-requests');
        assert.equal((await mockRequests()).length, 1);

        await resetMock();
        await mockScenario('token', 'server_error');
        assertEnvelope(await mint(), 502, 'upstream_error');
        assert.equal((await mockRequests()).length, 1);
    });
});
