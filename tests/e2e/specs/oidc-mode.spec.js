import { test, expect } from '../support/test.js';

// The oidc identity: the server accepts a bearer token from your sign-in
// provider. Here a throwaway issuer signs it, and the page's requests carry it
// the way a host app that called setAuthHeaderProvider() would send it.

test.use({ serverMode: 'oidc' });

test.describe('oidc identity', () => {
    test('explains the sign-in when the page sends no token', async ({ page, app }) => {
        await app.goto('/contacts');
        await expect(page.getByRole('heading', { name: 'Sign in with your account', level: 1 })).toBeVisible();
        await expect(page.getByRole('main')).toContainText('setAuthHeaderProvider');
        await expect(page.getByLabel('Passcode')).toHaveCount(0);
    });

    test('loads the CRM when the token is accepted, as the user the token names', async ({ page, app, crm, issuer, dropcowboy }) => {
        const ada = await crm.person('ada');
        const subject = 'f1e2d3c4-b5a6-4789-8abc-0d1e2f3a4b5c';
        const token = issuer.token({ claims: { sub: subject, email: 'sam@example.com' } });
        await page.route('**/api/**', (route) => route.continue({ headers: { ...route.request().headers(), authorization: 'Bearer ' + token } }));

        await app.goto('/contacts');
        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: ada.full_name })).toBeVisible();
        if (crm.fake) {
            const mints = dropcowboy.mintsFor('contacts');
            expect(mints.length).toBeGreaterThan(0);
            expect(mints.every((mint) => mint.sub === subject)).toBe(true);
        }
    });

    test('a token from the wrong audience gets the sign-in explanation, not the CRM', async ({ page, app, issuer }) => {
        const token = issuer.token({ claims: { aud: 'someone-else' } });
        await page.route('**/api/**', (route) => route.continue({ headers: { ...route.request().headers(), authorization: 'Bearer ' + token } }));
        await app.goto('/contacts');
        await expect(page.getByRole('heading', { name: /Sign in/ }).first()).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    });

    // @fake-only: the live run proves the server end to end; this proves the page's own stream reader.
    test('streams live events with the identity header, through the fetch-based reader @fake-only', async ({ page, app, crm, issuer }) => {
        const ada = await crm.person('ada');
        await app.goto('/');
        const token = issuer.token();

        await page.evaluate(async (bearer) => {
            const api = await import('/shared/server-api.js');
            const events = await import('/shared/events.js');
            api.setAuthHeaderProvider(() => ({ Authorization: 'Bearer ' + bearer }));
            window.seenEvents = [];
            window.streamStatus = 'connecting';
            window.stream = events.connectEvents({
                onEvent: (event) => window.seenEvents.push(event.event),
                onStatus: (status) => {
                    window.streamStatus = status;
                }
            });
        }, token);
        await page.waitForFunction(() => window.streamStatus === 'open');

        await crm.triggerWebhook('contact.updated', ada);
        await page.waitForFunction(() => window.seenEvents.includes('contact.updated'));
        await page.evaluate(() => window.stream.close());
    });
});
