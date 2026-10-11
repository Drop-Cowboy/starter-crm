import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { assertEnvelope, bearer, call, ctx, mockRequests, mockScenario, resetMock } from '../lib/context.js';
import { CANARY } from '../mock-upstream.js';

const EXPECTED = {
    embed_ready: false,
    next_actions: ['rent_number'],
    building_blocks_enabled: true,
    byoc: { connected: true, providers: [{ provider: 'twilio', enabled: true, default: true }] },
    funds: { available: 25, funds_ok: true },
    allotment: {
        sms: { remaining: 480, cap: 500 },
        dialer_minutes: { remaining: 100, cap: 100 }
    },
    numbers: { count: 1 },
    embed_resolve_contact_consent: true
};

const PRIVATE = ['9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b', 'developer-plan', '+13125550142', '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'];

const readiness = (mode, headers = mode === 'login' ? bearer() : {}) => call(mode, '/api/dropcowboy/readiness', { headers });

describe('GET /api/dropcowboy/readiness', () => {
    beforeEach(resetMock);

    it('server: proxies with the API key and returns only the setup-page fields', async () => {
        const res = await readiness('server');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(res.body, EXPECTED);

        const [upstream] = await mockRequests();
        assert.equal(upstream.method, 'GET');
        assert.equal(upstream.path, '/register/public/integration-readiness');
        assert.equal(upstream.credentials, 'api_key');
        assert.equal(upstream.headers['x-key'], ctx.secrets.apiKey);
        assert.equal(upstream.headers['x-secret'], ctx.secrets.apiSecret);
    });

    it('login: forwards the bearer instead of the API key, with the same fields', async () => {
        const res = await readiness('login');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(res.body, EXPECTED);

        const [upstream] = await mockRequests();
        assert.equal(upstream.credentials, 'bearer');
        assert.equal(upstream.headers.authorization, 'Bearer ' + ctx.secrets.accessToken);
        assert.equal(upstream.headers['x-key'], undefined);
    });

    for (const mode of ['server', 'login']) {
        it(mode + ': drops pool ids, plan ids, phone numbers and integration ids', async () => {
            const res = await readiness(mode);
            for (const leaked of PRIVATE) {
                assert.ok(!res.text.includes(leaked), 'readiness leaked ' + leaked);
            }
        });
    }

    it('login: without a bearer -> 401 login_required, upstream never called', async () => {
        assertEnvelope(await readiness('login', {}), 401, 'login_required');
        assert.deepEqual(await mockRequests(), []);
    });

    it('login: an expired sign-in -> 401 login_expired', async () => {
        const res = await readiness('login', bearer(ctx.secrets.expiredAccessToken));
        assertEnvelope(res, 401, 'login_expired');
        assert.ok(!res.text.includes(ctx.secrets.expiredAccessToken), 'the access token leaked into the response');
    });

    const cases = [
        ['server', 'insufficient_scope', 403, 'insufficient-scope'],
        ['server', 'unauthorized', 502, 'upstream_auth_failed'],
        ['server', 'server_error', 502, 'upstream_error'],
        ['server', 'slow', 504, 'upstream_timeout'],
        ['login', 'insufficient_scope', 403, 'insufficient-scope'],
        ['login', 'unauthorized', 401, 'login_expired'],
        ['login', 'server_error', 502, 'upstream_error']
    ];
    for (const [mode, scenario, status, code] of cases) {
        it(mode + ': ' + scenario + ' -> ' + status + ' ' + code, async () => {
            await mockScenario('readiness', scenario);
            const res = await readiness(mode);
            assertEnvelope(res, status, code);
            assert.ok(!res.text.includes(CANARY), 'the raw upstream body leaked into the response');
        });
    }
});
