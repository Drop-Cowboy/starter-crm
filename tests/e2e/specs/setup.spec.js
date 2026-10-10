import { expectAccessible } from '../support/a11y.js';
import { test, expect } from '../support/test.js';

test.describe('Setup page', () => {
    test('shows the account checklist from Drop Cowboy', async ({ page, app }) => {
        await app.goto('/setup');

        await expect(page.getByRole('heading', { name: 'Setup', level: 1 })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'How this app signs in: server' })).toBeVisible();

        const checklist = page.locator('ol.checklist');
        await expect(checklist.locator('#enable_building_blocks')).toContainText('Turn on Building Blocks');
        await expect(checklist.locator('#connect_byoc')).toContainText('Connect your carrier (BYOC)');
        await expect(checklist.locator('#site_id')).toContainText('A site id for this app');

        await expectAccessible(page);
    });
});
