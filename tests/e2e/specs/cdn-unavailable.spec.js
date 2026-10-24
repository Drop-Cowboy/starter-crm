import { expectAccessible } from '../support/a11y.js';
import { CDN_ORIGIN } from '../support/cdn.js';
import { test, expect } from '../support/test.js';

// Front-end delivery (plan section 12, item 9): when the Building Blocks CDN
// cannot be reached, or a file fails its integrity check, the page says so in
// plain words. It never goes blank.

test.describe('The Building Blocks CDN is unreachable', () => {
    test('shows a plain message, links to the setup page, and keeps the page usable', async ({ page, app }) => {
        // Registered on the page, so it wins over the fixture's routes to the CDN.
        await page.route((url) => url.origin === CDN_ORIGIN, (route) => route.abort('connectionrefused'));
        await app.goto('/contacts');

        const message = page.getByRole('alert').filter({ hasText: 'Widgets could not load' });
        await expect(message.first()).toBeVisible();
        await expect(message.first()).toContainText('Building Blocks');
        await expect(page.getByRole('link', { name: 'Open setup' }).first()).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
        await expectAccessible(page);
    });

    test('refuses a script whose integrity hash does not match, with the same message', async ({ page, app }) => {
        // The bundle arrives, but its bytes are not the ones the manifest hashed.
        await page.route((url) => url.origin === CDN_ORIGIN && /\.js$/.test(url.pathname), (route) => route.fulfill({
            status: 200,
            contentType: 'text/javascript',
            body: 'window.__tampered = true;'
        }));
        await app.goto('/contacts');

        await expect(page.getByRole('alert').filter({ hasText: 'Widgets could not load' }).first()).toBeVisible();
        expect(await page.evaluate(() => window.__tampered)).toBeUndefined();
    });
});
