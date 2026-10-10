import { expectAccessible } from '../support/a11y.js';
import { test, expect } from '../support/test.js';

// mcp-session mode borrows a session an AI agent minted into
// .dropcowboy/session.json. Until that file exists, the app says how to get one.

test.use({ serverMode: 'mcp-session' });

test.describe('mcp-session mode without a session file', () => {
    test('tells the developer how to get a session', async ({ page, app, dropcowboy }) => {
        await app.goto('/setup');

        const main = page.getByRole('main');
        await expect(page.getByRole('heading', { name: 'How this app signs in: mcp-session' })).toBeVisible();
        await expect(main).toContainText('No development session yet');
        await expect(main).toContainText('.dropcowboy/session.json');
        expect(dropcowboy.mints).toEqual([]);
        await expectAccessible(page);
    });

    test('the contacts list says the same', async ({ page, app }) => {
        await app.goto('/contacts');

        await expect(page.getByRole('region', { name: 'Contacts' })).toContainText('No development session yet');
        await expectAccessible(page);
    });
});
