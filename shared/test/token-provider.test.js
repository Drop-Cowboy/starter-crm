import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTokenProvider, createTokenStore } from '../token-provider.js';
import { header, jsonResponse, scriptedFetch } from './helpers.js';

const LATER = () => Date.now() + 15 * 60000;

function fakeLogin(accessToken) {
    const login = {
        token: accessToken,
        signedOut: false,
        isConfigured: () => true,
        accessToken: () => login.token,
        signOut() {
            login.token = null;
            login.signedOut = true;
        }
    };
    return login;
}

describe('token provider: server mode', () => {
    it('posts the purpose, never scopes, and returns only token and expires_at', async () => {
        const expiresAt = LATER();
        const fetch = scriptedFetch([() => jsonResponse(200, { token: 'site-1', expires_at: expiresAt, extra: 'dropped' })]);
        const provider = createTokenProvider({ config: { auth_mode: 'server' }, fetch });
        const token = await provider.fetchToken('session');

        assert.deepEqual(token, { token: 'site-1', expires_at: expiresAt });
        assert.equal(fetch.calls[0].url, '/api/dropcowboy/token');
        assert.equal(fetch.calls[0].init.method, 'POST');
        assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { purpose: 'session' });
        assert.equal(header(fetch.calls[0].init, 'authorization'), undefined);
    });

    it('passes mint errors through with their code', async () => {
        const fetch = scriptedFetch([() => jsonResponse(403, { error: { code: 'byoc_required', message: 'Connect a carrier.' } })]);
        const provider = createTokenProvider({ config: { auth_mode: 'server' }, fetch });
        await assert.rejects(provider.fetchToken('session'), { code: 'byoc_required', status: 403 });
    });

    it('refuses unknown purposes without calling the server', async () => {
        const fetch = scriptedFetch([]);
        const provider = createTokenProvider({ config: { auth_mode: 'server' }, fetch });
        await assert.rejects(provider.fetchToken('admin'), { code: 'invalid_purpose' });
        assert.equal(fetch.calls.length, 0);
    });

    it('mints the contacts purpose for the contacts pages', async () => {
        const fetch = scriptedFetch([() => jsonResponse(200, { token: 'contacts-1', expires_at: LATER() })]);
        const provider = createTokenProvider({ config: { auth_mode: 'server' }, fetch });
        assert.equal(provider.supports('contacts'), true);
        assert.equal((await provider.fetchToken('contacts')).token, 'contacts-1');
        assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { purpose: 'contacts' });
    });

    it('still gets a contacts token when the session mint fails with byoc_required', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(403, { error: { code: 'byoc_required', message: 'Connect a carrier.' } }),
            () => jsonResponse(200, { token: 'contacts-1', expires_at: LATER() })
        ]);
        const store = createTokenStore(createTokenProvider({ config: { auth_mode: 'server' }, fetch }));
        await assert.rejects(store.get('session'), { code: 'byoc_required' });
        assert.equal((await store.get('contacts')).token, 'contacts-1');
    });
});

describe('token provider: login mode', () => {
    it('sends the access token as a bearer header', async () => {
        const fetch = scriptedFetch([() => jsonResponse(200, { token: 'site-1', expires_at: LATER() })]);
        const provider = createTokenProvider({ config: { auth_mode: 'login' }, login: fakeLogin('access-1'), fetch });
        await provider.fetchToken('phone');
        assert.equal(header(fetch.calls[0].init, 'authorization'), 'Bearer access-1');
        assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { purpose: 'phone' });
    });

    it('throws login_required before calling the server when signed out', async () => {
        const fetch = scriptedFetch([]);
        const provider = createTokenProvider({ config: { auth_mode: 'login' }, login: fakeLogin(null), fetch });
        await assert.rejects(provider.fetchToken('session'), { code: 'login_required' });
        assert.equal(fetch.calls.length, 0);
    });

    it('passes the server login_required through', async () => {
        const fetch = scriptedFetch([() => jsonResponse(401, { error: { code: 'login_required', message: 'Sign in.' } })]);
        const provider = createTokenProvider({ config: { auth_mode: 'login' }, login: fakeLogin('malformed'), fetch });
        await assert.rejects(provider.fetchToken('session'), { code: 'login_required', status: 401 });
    });

    it('signs out on login_expired so the app offers sign-in again', async () => {
        const login = fakeLogin('access-1');
        const fetch = scriptedFetch([() => jsonResponse(401, { error: { code: 'login_expired', message: 'Expired.' } })]);
        const provider = createTokenProvider({ config: { auth_mode: 'login' }, login, fetch });
        await assert.rejects(provider.fetchToken('session'), { code: 'login_expired' });
        assert.equal(login.signedOut, true);
        await assert.rejects(provider.fetchToken('session'), { code: 'login_required' });
    });

    it('explains a missing client id', async () => {
        const login = fakeLogin('access-1');
        login.isConfigured = () => false;
        const provider = createTokenProvider({ config: { auth_mode: 'login' }, login, fetch: scriptedFetch([]) });
        await assert.rejects(provider.fetchToken('session'), { code: 'login_not_configured' });
    });
});

describe('token provider: mcp-session mode', () => {
    it('reads the dev session file for the session purpose', async () => {
        const expiresAt = LATER();
        const fetch = scriptedFetch([() => jsonResponse(200, { token: 'dev-1', expires_at: expiresAt, site_id: null })]);
        const provider = createTokenProvider({ config: { auth_mode: 'mcp-session' }, fetch });
        assert.deepEqual(await provider.fetchToken('session'), { token: 'dev-1', expires_at: expiresAt });
        assert.equal(fetch.calls[0].url, '/__dev/session');
    });

    it('hands the contacts pages the same dev session token', async () => {
        const expiresAt = LATER();
        const fetch = scriptedFetch([() => jsonResponse(200, { token: 'dev-1', expires_at: expiresAt, site_id: null })]);
        const provider = createTokenProvider({ config: { auth_mode: 'mcp-session' }, fetch });
        assert.equal(provider.supports('contacts'), true);
        assert.deepEqual(await provider.fetchToken('contacts'), { token: 'dev-1', expires_at: expiresAt });
        assert.equal(fetch.calls[0].url, '/__dev/session');
    });

    it('has no campaigns or phone token', async () => {
        const provider = createTokenProvider({ config: { auth_mode: 'mcp-session' }, fetch: scriptedFetch([]) });
        assert.equal(provider.supports('campaigns'), false);
        await assert.rejects(provider.fetchToken('phone'), { code: 'purpose_unavailable' });
    });

    it('passes session_not_found through', async () => {
        const fetch = scriptedFetch([() => jsonResponse(404, { error: { code: 'session_not_found', message: 'Create it.' } })]);
        const provider = createTokenProvider({ config: { auth_mode: 'mcp-session' }, fetch });
        await assert.rejects(provider.fetchToken('session'), { code: 'session_not_found' });
    });
});

describe('token store', () => {
    function countingProvider(expiresIn) {
        let count = 0;
        return {
            supports: () => true,
            get count() {
                return count;
            },
            fetchToken: async (purpose) => {
                count += 1;
                return { token: purpose + '-' + count, expires_at: Date.now() + expiresIn };
            }
        };
    }

    it('reuses a token with time left and shares one mint between callers', async () => {
        const provider = countingProvider(15 * 60000);
        const store = createTokenStore(provider);
        const [a, b] = await Promise.all([store.get('session'), store.get('session')]);
        assert.equal(a.token, 'session-1');
        assert.equal(b.token, 'session-1');
        assert.equal((await store.get('session')).token, 'session-1');
        assert.equal(provider.count, 1);
    });

    it('mints again when the token is about to expire, and on refresh()', async () => {
        const provider = countingProvider(30000);
        const store = createTokenStore(provider);
        await store.get('session');
        assert.equal((await store.get('session')).token, 'session-2');
        assert.equal((await store.refresh('session')).token, 'session-3');
    });

    it('keeps purposes apart', async () => {
        const store = createTokenStore(countingProvider(15 * 60000));
        assert.equal((await store.get('session')).token, 'session-1');
        assert.equal((await store.get('campaigns')).token, 'campaigns-2');
    });

    it('lets a failed mint be retried', async () => {
        let fail = true;
        const store = createTokenStore({
            supports: () => true,
            fetchToken: async () => {
                if (fail) {
                    fail = false;
                    throw new Error('down');
                }
                return { token: 't', expires_at: Date.now() + 600000 };
            }
        });
        await assert.rejects(store.get('session'));
        assert.equal((await store.get('session')).token, 't');
    });
});
