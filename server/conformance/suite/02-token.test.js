import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { assertEnvelope, bearer, ctx, mockRequests, mockScenario, postJson, resetMock } from '../lib/context.js';
import { CANARY, MOCK_TOKEN } from '../mock-upstream.js';

const PURPOSES = {
    session: ['dialer:webrtc', 'contacts'],
    contacts: ['contacts'],
    campaigns: ['campaigns'],
    phone: ['phone:hub']
};

const mint = (body, headers) => postJson('server', '/api/dropcowboy/token', body, headers);
const loginMint = (body, headers = bearer()) => postJson('login', '/api/dropcowboy/token', body, headers);

function assertMinted(res) {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(res.body).sort(), ['expires_at', 'token']);
    assert.equal(res.body.token, MOCK_TOKEN);
    assert.equal(typeof res.body.expires_at, 'number');
}

describe('POST /api/dropcowboy/token (server mode)', () => {
    beforeEach(resetMock);

    for (const [purpose, scope] of Object.entries(PURPOSES)) {
        it(purpose + ': mints ' + scope.join(' + ') + ' and returns only token and expires_at', async () => {
            assertMinted(await mint({ purpose }));

            const [upstream] = await mockRequests();
            assert.equal(upstream.method, 'POST');
            assert.equal(upstream.path, '/phone/public/embed/token');
            assert.equal(upstream.credentials, 'api_key');
            assert.equal(upstream.headers['x-key'], ctx.secrets.apiKey);
            assert.equal(upstream.headers['x-secret'], ctx.secrets.apiSecret);
            assert.deepEqual(upstream.body, { site_id: ctx.siteId, sub: ctx.userId, scope, ttl_seconds: 900 });
        });
    }

    it('ignores scope, sub, site_id and ttl_seconds from the browser', async () => {
        const res = await mint({
            purpose: 'phone',
            scope: ['numbers:write', 'phone:hub'],
            sub: 'someone-else',
            site_id: '00000000-0000-4000-8000-000000000000',
            ttl_seconds: 86400
        });
        assert.equal(res.status, 200);
        const [upstream] = await mockRequests();
        assert.deepEqual(upstream.body, { site_id: ctx.siteId, sub: ctx.userId, scope: ['phone:hub'], ttl_seconds: 900 });
    });

    it('never forwards a bearer the browser sent', async () => {
        assertMinted(await mint({ purpose: 'session' }, bearer()));
        const [upstream] = await mockRequests();
        assert.equal(upstream.credentials, 'api_key');
        assert.equal(upstream.headers.authorization, undefined);
    });

    const badPurposes = [
        ['an unknown purpose', { purpose: 'admin' }],
        ['a scope name', { purpose: 'numbers:write' }],
        ['a prototype key', { purpose: 'constructor' }],
        ['__proto__', { purpose: '__proto__' }],
        ['a missing purpose', { scope: ['contacts'] }],
        ['a non-string purpose', { purpose: ['session'] }],
        ['an array body', [{ purpose: 'session' }]]
    ];
    for (const [label, body] of badPurposes) {
        it('rejects ' + label + ' with 400 invalid_purpose and never calls upstream', async () => {
            assertEnvelope(await mint(body), 400, 'invalid_purpose');
            assert.deepEqual(await mockRequests(), []);
        });
    }

    it('names every purpose in the invalid_purpose message', async () => {
        const res = await mint({ purpose: 'admin' });
        assertEnvelope(res, 400, 'invalid_purpose');
        for (const purpose of Object.keys(PURPOSES)) {
            assert.ok(res.body.error.message.includes(purpose), 'the message does not name ' + purpose);
        }
    });

    it('rejects malformed JSON with 400 invalid_json', async () => {
        assertEnvelope(await mint('{"purpose": "session"'), 400, 'invalid_json');
        assert.deepEqual(await mockRequests(), []);
    });
});

describe('POST /api/dropcowboy/token (login mode)', () => {
    beforeEach(resetMock);

    for (const [purpose, scope] of Object.entries(PURPOSES)) {
        it(purpose + ': forwards the bearer instead of the API key, mapping to ' + scope.join(' + '), async () => {
            assertMinted(await loginMint({ purpose }));

            const [upstream] = await mockRequests();
            assert.equal(upstream.path, '/phone/public/embed/token');
            assert.equal(upstream.credentials, 'bearer');
            assert.equal(upstream.headers.authorization, 'Bearer ' + ctx.secrets.accessToken);
            assert.equal(upstream.headers['x-key'], undefined);
            assert.equal(upstream.headers['x-secret'], undefined);
            assert.deepEqual(upstream.body, { site_id: ctx.siteId, scope, ttl_seconds: 900 });
        });
    }

    it('sends no sub, and ignores scope, sub, site_id and ttl_seconds from the browser', async () => {
        await loginMint({
            purpose: 'campaigns',
            scope: ['numbers:write'],
            sub: 'someone-else',
            site_id: '00000000-0000-4000-8000-000000000000',
            ttl_seconds: 86400
        });
        const [upstream] = await mockRequests();
        assert.deepEqual(upstream.body, { site_id: ctx.siteId, scope: ['campaigns'], ttl_seconds: 900 });
    });

    it('accepts the scheme in any case and forwards it as "Bearer"', async () => {
        assertMinted(await loginMint({ purpose: 'session' }, { authorization: 'bearer ' + ctx.secrets.accessToken }));
        const [upstream] = await mockRequests();
        assert.equal(upstream.headers.authorization, 'Bearer ' + ctx.secrets.accessToken);
    });

    const notSignedIn = [
        ['no Authorization header', {}],
        ['another scheme', { authorization: 'Basic ' + Buffer.from('user:pass').toString('base64') }],
        ['an empty bearer', { authorization: 'Bearer' }],
        ['two tokens', { authorization: 'Bearer one two' }],
        ['a token with a comma', { authorization: 'Bearer one,two' }]
    ];
    for (const [label, headers] of notSignedIn) {
        it(label + ' -> 401 login_required, upstream never called', async () => {
            assertEnvelope(await loginMint({ purpose: 'session' }, headers), 401, 'login_required');
            assert.deepEqual(await mockRequests(), []);
        });
    }

    it('checks the sign-in before the body: no bearer and bad JSON is 401 login_required', async () => {
        assertEnvelope(await loginMint('{"purpose":', {}), 401, 'login_required');
    });

    it('rejects an invalid purpose with 400 invalid_purpose and never calls upstream', async () => {
        assertEnvelope(await loginMint({ purpose: 'admin' }), 400, 'invalid_purpose');
        assert.deepEqual(await mockRequests(), []);
    });

    it('an expired sign-in -> 401 login_expired, and the token is never echoed', async () => {
        const res = await loginMint({ purpose: 'session' }, bearer(ctx.secrets.expiredAccessToken));
        assertEnvelope(res, 401, 'login_expired');
        assert.ok(!res.text.includes(ctx.secrets.expiredAccessToken), 'the access token leaked into the response');
        const [upstream] = await mockRequests();
        assert.equal(upstream.credentials, 'bearer');
    });
});

// The same upstream answers map the same way in both modes, except a 401: in
// server mode it means this server's API key is wrong (502), in login mode
// that the user must sign in again (401).
for (const [mode, unauthorized] of [['server', [502, 'upstream_auth_failed']], ['login', [401, 'login_expired']]]) {
    describe('Drop Cowboy errors on the token route (' + mode + ' mode)', () => {
        beforeEach(resetMock);
        const send = () => (mode === 'login' ? loginMint({ purpose: 'session' }) : mint({ purpose: 'session' }));

        const cases = [
            ['payment_required', 402, 'payment-required', 'Add funds to continue.'],
            ['insufficient_scope', 403, 'insufficient-scope', 'This endpoint requires one of: numbers:write'],
            ['consent_required', 403, 'consent_required', 'A valid consent_id is required for this embed send'],
            ['rate_limited', 429, 'too-many-requests', 'Slow down.'],
            ['unauthorized', ...unauthorized],
            ['server_error', 502, 'upstream_error'],
            ['not_json', 502, 'upstream_error'],
            ['bad_success', 502, 'upstream_error'],
            ['slow', 504, 'upstream_timeout']
        ];

        for (const [scenario, status, code, message] of cases) {
            it(scenario + ' -> ' + status + ' ' + code, async () => {
                await mockScenario('token', scenario);
                const res = await send();
                assertEnvelope(res, status, code);
                if (message) assert.equal(res.body.error.message, message);
                assert.ok(!res.text.includes(CANARY), 'the raw upstream body leaked into the response');
                for (const secret of Object.values(ctx.secrets)) {
                    assert.ok(!res.text.includes(secret), 'a secret leaked into the response');
                }
            });
        }

        it('copies Retry-After on 429', async () => {
            await mockScenario('token', 'rate_limited');
            const res = await send();
            assert.equal(res.headers.get('retry-after'), '7');
        });
    });
}
