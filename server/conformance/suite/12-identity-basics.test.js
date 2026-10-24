import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { assertEnvelope, call, client, ctx, mockRequests, postJson, resetMock, uuidv5 } from '../lib/context.js';

describe('identity: /api/auth/session', () => {
    it('/api/config does not change shape: the identity is named by the session endpoint', async () => {
        const res = await call('passcode', '/api/config');
        assert.equal(Object.hasOwn(res.body, 'identity'), false);
    });

    it('the dev identity is always signed in as STARTER_CRM_USER_ID', async () => {
        const res = await call('server', '/api/auth/session');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(res.body, { identity: 'dev', signed_in: true, user: { id: ctx.userId } });
    });

    it('is only registered in server mode', async () => {
        for (const mode of ['login', 'mcp-session']) {
            assertEnvelope(await call(mode, '/api/auth/session'), 404, 'not_found');
        }
    });

    it('the passcode routes exist only with the passcode identity', async () => {
        for (const path of ['/api/auth/passcode', '/api/auth/signout']) {
            assertEnvelope(await postJson('server', path, {}), 404, 'not_found');
            assertEnvelope(await postJson('custom', path, {}), 404, 'not_found');
        }
    });
});

describe('identity: a custom provider', () => {
    beforeEach(resetMock);
    const user = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';

    it('is signed out without credentials, and session never answers 401', async () => {
        const res = await call('custom', '/api/auth/session', { headers: client() });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { identity: 'custom', signed_in: false, user: null });
    });

    it('is signed in with the provider\'s credential, carrying the fields it returns', async () => {
        const res = await call('custom', '/api/auth/session', { headers: { ...client(), 'x-test-user': user } });
        assert.deepEqual(res.body, { identity: 'custom', signed_in: true, user: { id: user, email: 'tester@example.com' } });
    });

    it('protected routes answer 401 unauthenticated, and Drop Cowboy is never called', async () => {
        const token = await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, client());
        assertEnvelope(token, 401, 'unauthenticated');
        for (const path of ['/api/dropcowboy/readiness', '/api/events']) {
            assertEnvelope(await call('custom', path, { headers: client() }), 401, 'unauthenticated');
        }
        assert.deepEqual(await mockRequests(), []);
    });

    it('mints for the user the provider returned', async () => {
        const res = await postJson('custom', '/api/dropcowboy/token', { purpose: 'session' }, { ...client(), 'x-test-user': user });
        assert.equal(res.status, 200);
        const [upstream] = await mockRequests();
        assert.equal(upstream.body.sub, user);
    });

    it('webhooks do not need an identity', async () => {
        const res = await call('custom', '/webhooks/dropcowboy', { method: 'POST', body: '{}' });
        assertEnvelope(res, 401, 'missing_signature');
    });

    it('derives nothing from the site id for a plain id', () => {
        assert.notEqual(uuidv5(ctx.siteId, 'x'), user);
    });
});
