import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogin } from '../login.js';
import { jsonResponse, memoryStorage, scriptedFetch } from './helpers.js';

const AUTH0 = { domain: 'login.dropcowboy.com', client_id: 'public-client', audience: 'https://api-v2.dropcowboy.com' };

function fakeBrowser(href) {
    const browser = {
        location: {
            href,
            assigned: null,
            assign(url) {
                browser.location.assigned = url;
            }
        },
        history: {
            replaced: null,
            replaceState(data, unused, url) {
                browser.history.replaced = url;
            }
        },
        storage: memoryStorage()
    };
    return browser;
}

function loginFor(browser, extra) {
    return createLogin(Object.assign({
        auth0: AUTH0,
        redirectUri: 'http://localhost:8080/',
        storage: browser.storage,
        location: browser.location,
        history: browser.history
    }, extra));
}

describe('login', () => {
    it('signs in, exchanges the code, and keeps the token in memory only', async () => {
        const browser = fakeBrowser('http://localhost:8080/contacts');
        await loginFor(browser).signIn('/contacts');
        const authorize = new URL(browser.location.assigned);
        const state = authorize.searchParams.get('state');

        browser.location.href = 'http://localhost:8080/?code=one-time&state=' + state;
        const fetch = scriptedFetch([() => jsonResponse(200, { access_token: 'access-1', expires_in: 3600 })]);
        const login = loginFor(browser, { fetch });
        const returnTo = await login.handleCallback();

        assert.equal(returnTo, '/contacts');
        assert.equal(browser.history.replaced, '/contacts');
        assert.equal(login.accessToken(), 'access-1');
        assert.deepEqual(browser.storage.keys(), []);
    });

    it('rejects a callback whose state does not match', async () => {
        const browser = fakeBrowser('http://localhost:8080/');
        await loginFor(browser).signIn('/');
        browser.location.href = 'http://localhost:8080/?code=one-time&state=forged';
        await assert.rejects(loginFor(browser).handleCallback(), { code: 'login_failed' });
        assert.equal(browser.history.replaced, '/');
    });

    it('reports an error callback', async () => {
        const browser = fakeBrowser('http://localhost:8080/?error=access_denied&error_description=Denied');
        await assert.rejects(loginFor(browser).handleCallback(), { code: 'login_failed', message: 'Denied' });
    });

    it('returns null when the page is not a callback', async () => {
        const browser = fakeBrowser('http://localhost:8080/contacts');
        assert.equal(await loginFor(browser).handleCallback(), null);
    });

    it('forgets an expired access token', async () => {
        const browser = fakeBrowser('http://localhost:8080/');
        await loginFor(browser).signIn('/');
        const state = new URL(browser.location.assigned).searchParams.get('state');
        browser.location.href = 'http://localhost:8080/?code=c&state=' + state;
        let now = Date.now();
        const login = loginFor(browser, {
            fetch: scriptedFetch([() => jsonResponse(200, { access_token: 'access-1', expires_in: 60 })]),
            now: () => now
        });
        await login.handleCallback();
        assert.equal(login.isSignedIn(), true);
        now += 61000;
        assert.equal(login.accessToken(), null);
    });

    it('refuses to start without a client id', async () => {
        const browser = fakeBrowser('http://localhost:8080/');
        const login = loginFor(browser, { auth0: { domain: 'login.dropcowboy.com', client_id: null, audience: 'a' } });
        assert.equal(login.isConfigured(), false);
        await assert.rejects(login.signIn('/'), { code: 'login_not_configured' });
    });
});
