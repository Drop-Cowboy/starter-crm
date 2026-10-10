import crypto from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { CDN_ORIGIN, findCdnDir, loadCdn } from './cdn.js';
import { fakeJwt, startFakeDropCowboy, WIDGET_API_ORIGIN } from './fake-dropcowboy.js';
import { findLeaks, readPage } from './leaks.js';
import { startAppServer } from './app-server.js';

// The fixtures every spec uses. Per worker: one fake Drop Cowboy account and
// one starter server. Per test: a fresh account, a browser whose only way out
// is the starter server (everything else is answered locally or blocked), and
// a check afterwards that no token leaked anywhere in the browser.
//
//   ui          'vanilla' or 'react', set by the Playwright project.
//   serverMode  'server' (default), 'login', 'login-not-configured' or
//               'mcp-session'. Set it with test.use({ serverMode }).

export const test = base.extend({
    ui: ['vanilla', { option: true, scope: 'worker' }],
    serverMode: ['server', { option: true, scope: 'worker' }],

    secrets: [async ({}, use) => {
        await use({
            apiKey: 'e2e-key-' + crypto.randomUUID(),
            apiSecret: 'e2e-secret-' + crypto.randomUUID(),
            webhookSecret: 'e2e-webhook-' + crypto.randomUUID(),
            loginClientId: 'e2e-public-client-' + crypto.randomUUID(),
            // What the sign-in page hands back in login mode; JWT-shaped like a real one.
            loginAccessToken: fakeJwt({ sub: 'auth0|' + crypto.randomUUID(), aud: 'https://api-v2.dropcowboy.com' })
        });
    }, { scope: 'worker' }],

    dropcowboy: [async ({ secrets }, use) => {
        const fake = await startFakeDropCowboy({
            apiKey: secrets.apiKey,
            apiSecret: secrets.apiSecret,
            accessTokens: [secrets.loginAccessToken]
        });
        await use(fake);
        await fake.close();
    }, { scope: 'worker' }],

    appServer: [async ({ serverMode, ui, dropcowboy, secrets }, use) => {
        const server = await startAppServer({ mode: serverMode, ui, fakeUrl: dropcowboy.url, secrets });
        await use(server);
        await server.stop();
        const leaks = findLeaks({ 'The starter server\'s output': server.output() }, [
            ...dropcowboy.secrets(), secrets.apiKey, secrets.apiSecret, secrets.webhookSecret, secrets.loginAccessToken
        ]);
        if (leaks.length) {
            throw new Error(leaks.join('; ') + '. Servers must never log tokens or secrets.');
        }
    }, { scope: 'worker' }],

    cdn: [async ({}, use) => {
        await use(loadCdn(findCdnDir()));
    }, { scope: 'worker' }],

    baseURL: async ({ appServer }, use) => {
        await use(appServer.url);
    },

    context: async ({ context, appServer, dropcowboy, cdn }, use) => {
        dropcowboy.reset();
        const blocked = [];
        const sockets = [];
        const local = new URL(appServer.url).origin;

        await context.route((url) => url.origin !== local, async (route) => {
            const request = route.request();
            const origin = new URL(request.url()).origin;
            if (origin === CDN_ORIGIN) {
                const file = cdn.answer(request.url());
                return route.fulfill({
                    status: file.status,
                    body: file.body,
                    contentType: file.contentType,
                    headers: { 'access-control-allow-origin': '*' }
                });
            }
            if (origin === WIDGET_API_ORIGIN) {
                return route.fulfill(dropcowboy.answerBrowser({
                    method: request.method(),
                    url: request.url(),
                    headers: await request.allHeaders(),
                    body: request.postData()
                }));
            }
            blocked.push(request.method() + ' ' + request.url());
            return route.abort('blockedbyclient');
        });
        // The dialer opens a SIP WebSocket after it is given credentials.
        // Accept it and stay silent: no call ever leaves the test.
        await context.routeWebSocket((url) => url.origin !== local.replace(/^http/, 'ws'), (ws) => {
            sockets.push(ws.url());
        });

        await use(Object.assign(context, { blocked, sockets }));
    },

    /** Helpers for driving either front-end with the same test code. */
    app: async ({ page, ui }, use) => {
        const prefix = ui === 'react' ? '/react' : '';
        await use({
            ui,
            path: (to) => prefix + to,
            url: (to) => new RegExp(escapeRegExp(prefix + to) + '(\\?.*)?$'),
            goto: (to) => page.goto(prefix + to),
            /** The live region both front-ends show short confirmations in. */
            toasts: page.locator('.toasts'),
            /** The number texts are sent from; set before the page loads. */
            async useBusinessNumber(number) {
                await page.addInitScript((value) => {
                    localStorage.setItem('starter-crm.business-number', value);
                }, number);
            },
            /** Records what the page asks the Dock to do, once the Dock has loaded. */
            async watchDock() {
                await page.waitForFunction(() => window.DropCowboy && window.DropCowboy.dock
                    && typeof window.DropCowboy.dock.dial === 'function');
                await page.evaluate(() => {
                    const dock = window.DropCowboy.dock;
                    window.dockCalls = [];
                    for (const method of ['dial', 'text']) {
                        const original = dock[method];
                        dock[method] = function (target, options) {
                            window.dockCalls.push({ method, target });
                            return original.call(this, target, options);
                        };
                    }
                });
            },
            dockCalls: () => page.evaluate(() => window.dockCalls || [])
        });
    },

    // Runs around every test: collects what the browser saw, then fails the
    // test if a token or secret turned up anywhere it should not.
    leakCheck: [async ({ context, dropcowboy, secrets, cdn }, use, testInfo) => {
        const seen = { urls: [], console: [] };
        context.on('request', (request) => seen.urls.push(request.url()));
        context.on('console', (message) => seen.console.push(message.type() + ': ' + message.text()));
        context.on('weberror', (error) => seen.console.push('pageerror: ' + error.error().message));

        await use(seen);

        const haystacks = {
            'A requested URL': seen.urls.join('\n'),
            'A WebSocket URL': context.sockets.join('\n'),
            'The console': seen.console.join('\n')
        };
        for (const page of context.pages()) {
            const snapshot = await readPage(page).catch(() => null);
            if (!snapshot) continue;
            haystacks['The page at ' + snapshot.url] = snapshot.dom;
            haystacks['localStorage'] = JSON.stringify(snapshot.localStorage);
            haystacks['sessionStorage'] = JSON.stringify(snapshot.sessionStorage);
            haystacks['document.cookie'] = snapshot.cookies;
        }
        const leaks = findLeaks(haystacks, [
            ...dropcowboy.secrets(), secrets.apiKey, secrets.apiSecret, secrets.webhookSecret, secrets.loginAccessToken
        ]);

        if (dropcowboy.unhandled.length) {
            testInfo.annotations.push({ type: 'unhandled widget API calls', description: dropcowboy.unhandled.join(', ') });
        }
        expect(leaks, 'Tokens and secrets must stay out of the page, URLs, storage and console').toEqual([]);
        expect(context.blocked, 'The page tried to reach hosts outside the starter').toEqual([]);
        expect(cdn.problems, 'Building Blocks bundles').toEqual([]);
    }, { auto: true }]
});

export { expect };

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
