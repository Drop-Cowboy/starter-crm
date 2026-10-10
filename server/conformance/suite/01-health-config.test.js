import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertEnvelope, call, ctx, postJson } from '../lib/context.js';

const MODES = ['login', 'server', 'mcp-session'];

describe('GET /healthz', () => {
    for (const mode of MODES) {
        it(mode + ': answers {"ok": true}', async () => {
            const res = await call(mode, '/healthz');
            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { ok: true });
        });
    }
});

describe('GET /api/config', () => {
    it('login: includes Auth0 settings and the configured values', async () => {
        const res = await call('login', '/api/config');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            auth_mode: 'login',
            site_id: ctx.siteId,
            api_base: ctx.mock,
            cdn_version: '1.2.3',
            auth0: {
                domain: 'login.dropcowboy.com',
                client_id: 'conformance-public-client-id',
                audience: 'https://api-v2.dropcowboy.com'
            }
        });
    });

    it('server: auth0 is null', async () => {
        const res = await call('server', '/api/config');
        assert.deepEqual(res.body, {
            auth_mode: 'server',
            site_id: ctx.siteId,
            api_base: ctx.mock,
            cdn_version: null,
            auth0: null
        });
    });

    it('mcp-session: unset values are null', async () => {
        const res = await call('mcp-session', '/api/config');
        assert.deepEqual(res.body, {
            auth_mode: 'mcp-session',
            site_id: null,
            api_base: ctx.mock,
            cdn_version: null,
            auth0: null
        });
    });

    for (const mode of MODES) {
        it(mode + ': never contains a secret', async () => {
            const res = await call(mode, '/api/config');
            for (const secret of Object.values(ctx.secrets)) {
                assert.ok(!res.text.includes(secret), 'config leaked a secret');
            }
        });
    }
});

describe('mode gating', () => {
    const cases = [
        ['POST', '/api/dropcowboy/token', ['mcp-session']],
        ['GET', '/api/dropcowboy/readiness', ['mcp-session']],
        ['GET', '/__dev/session', ['login', 'server']]
    ];
    for (const [method, path, absentIn] of cases) {
        for (const mode of absentIn) {
            it(mode + ': ' + method + ' ' + path + ' is 404 not_found', async () => {
                const res = method === 'POST'
                    ? await postJson(mode, path, { purpose: 'session' })
                    : await call(mode, path);
                assertEnvelope(res, 404, 'not_found');
            });
        }
    }
});

describe('unknown routes', () => {
    for (const path of ['/api/nothing', '/api/dropcowboy/nothing', '/__dev/nothing', '/webhooks/nothing']) {
        it('GET ' + path + ' is 404 not_found in the envelope', async () => {
            assertEnvelope(await call('login', path), 404, 'not_found');
        });
    }

    it('POST /healthz is 404 not_found', async () => {
        assertEnvelope(await postJson('login', '/healthz', {}), 404, 'not_found');
    });
});
