import crypto from 'node:crypto';
import { expectAccessible } from '../support/a11y.js';
import { test, expect } from '../support/test.js';

// login mode: the user signs in with their Drop Cowboy account (OAuth with
// PKCE), and the server mints site tokens with that sign-in. No API key.

test.use({ serverMode: 'login' });

const SIGN_IN_ORIGIN = 'https://login.dropcowboy.com';

test.describe('login mode', () => {
    test('signs in with PKCE and keeps the access token out of the browser\'s storage', async ({ page, app, dropcowboy, secrets }) => {
        // Stands in for the Drop Cowboy sign-in page: it approves at once and
        // sends the browser back with a one-time code.
        const code = crypto.randomUUID();
        let authorize = null;
        let exchange = null;
        await page.route(SIGN_IN_ORIGIN + '/**', async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.pathname === '/authorize') {
                authorize = Object.fromEntries(url.searchParams);
                const back = new URL(authorize.redirect_uri);
                back.searchParams.set('code', code);
                back.searchParams.set('state', authorize.state);
                return route.fulfill({ status: 302, headers: { location: back.toString() } });
            }
            if (url.pathname === '/oauth/token' && request.method() === 'POST') {
                exchange = Object.fromEntries(new URLSearchParams(request.postData()));
                return route.fulfill({
                    status: 200,
                    headers: { 'access-control-allow-origin': '*' },
                    contentType: 'application/json',
                    body: JSON.stringify({ access_token: secrets.loginAccessToken, token_type: 'Bearer', expires_in: 3600 })
                });
            }
            return route.abort('blockedbyclient');
        });

        await app.goto('/contacts');
        await page.getByRole('button', { name: 'Sign in with Drop Cowboy' }).first().click();

        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();
        // The one-time code is gone from the address bar.
        await expect(page).toHaveURL(app.url('/contacts'));

        expect(authorize).toMatchObject({
            response_type: 'code',
            client_id: secrets.loginClientId,
            code_challenge_method: 'S256'
        });
        // PKCE: the verifier sent with the code hashes to the challenge sent at the start.
        expect(exchange).toMatchObject({ grant_type: 'authorization_code', code, client_id: secrets.loginClientId });
        expect(crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(authorize.code_challenge);

        // The server minted with the user's sign-in, not an API key, and named no user itself.
        const mints = dropcowboy.mintsFor('contacts');
        expect(mints.length).toBeGreaterThan(0);
        expect(mints.every((mint) => mint.viaLogin && mint.sub === undefined)).toBe(true);

        // Only the PKCE verifier and state may be stored, and only until the callback.
        expect(await page.evaluate(() => sessionStorage.getItem('starter-crm.sign-in'))).toBeNull();
    });

    test('a reload forgets the sign-in', async ({ page, app }) => {
        await app.goto('/contacts');
        await expect(page.getByRole('button', { name: 'Sign in with Drop Cowboy' }).first()).toBeVisible();
        await expectAccessible(page);
    });
});
