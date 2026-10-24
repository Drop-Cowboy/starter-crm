import { expectAccessible } from '../support/a11y.js';
import { test, expect } from '../support/test.js';

// The passcode identity: one shared passcode, exchanged for an HttpOnly
// session cookie. Until then the CRM shows a sign-in screen and asks Drop
// Cowboy for nothing.

test.use({ serverMode: 'passcode' });

test.describe('passcode identity', () => {
    test('shows a sign-in screen, refuses a wrong passcode, and lets the right one in', async ({ page, app, crm, secrets, dropcowboy, context }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts');

        await expect(page.getByRole('heading', { name: 'Sign in to Starter CRM', level: 1 })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
        await expectAccessible(page);
        if (crm.fake) expect(dropcowboy.mints, 'nothing is minted before sign-in').toEqual([]);

        const field = page.getByLabel('Passcode');
        await field.fill('not-the-passcode-at-all');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('alert').filter({ hasText: 'That passcode is not right.' })).toBeVisible();
        // The leak check reads form values, so the wrong guess is cleared too.
        await field.fill('');

        await field.fill(secrets.passcode);
        await page.getByRole('button', { name: 'Sign in' }).click();

        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: ada.full_name })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

        // The browser holds a session cookie it cannot read, not the passcode.
        const [cookie] = (await context.cookies()).filter((item) => item.name === 'starter_crm_session');
        expect(cookie.httpOnly).toBe(true);
        expect(cookie.sameSite).toBe('Lax');
        expect(cookie.value).not.toContain(secrets.passcode);
        expect(await page.evaluate(() => document.cookie)).toBe('');
        expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(secrets.passcode);
    });

    test('stays signed in across a reload, and signs out', async ({ page, app, secrets }) => {
        await app.goto('/contacts');
        await page.getByLabel('Passcode').fill(secrets.passcode);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

        await page.reload();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Sign in to Starter CRM' })).toHaveCount(0);

        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('heading', { name: 'Sign in to Starter CRM', level: 1 })).toBeVisible();
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Sign in to Starter CRM', level: 1 })).toBeVisible();
    });

    test('a signed-out request to the API is refused, and a signed-in one works', async ({ page, app, appServer, secrets }) => {
        const refused = await page.request.get(appServer.url + '/api/events', { headers: { Accept: 'text/event-stream' }, timeout: 5000 });
        expect(refused.status()).toBe(401);
        expect((await refused.json()).error.code).toBe('unauthenticated');

        await app.goto('/contacts');
        await page.getByLabel('Passcode').fill(secrets.passcode);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
        await expect(page.locator('#activity-connection, .ctx-foot').first()).toBeAttached();
    });
});
