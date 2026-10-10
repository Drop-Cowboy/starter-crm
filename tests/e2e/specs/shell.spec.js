import { expectAccessible } from '../support/a11y.js';
import { ADA, GRACE } from '../support/data.js';
import { test, expect } from '../support/test.js';

// The frame around every page: navigation, the command palette, the
// embedded layout and the dark theme.

test.describe('Navigation', () => {
    test('marks the current page, and collapses and expands', async ({ page, app }) => {
        await app.goto('/pipeline');
        const nav = page.getByRole('navigation', { name: 'Main' });
        await expect(nav.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page');
        await expect(nav.getByRole('link', { name: 'Contacts' })).not.toHaveAttribute('aria-current', 'page');

        const toggle = nav.getByRole('button', { name: 'Expand navigation' });
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#app')).toHaveAttribute('data-nav', 'collapsed');
        await toggle.click();
        const collapse = nav.getByRole('button', { name: 'Collapse navigation' });
        await expect(collapse).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#app')).toHaveAttribute('data-nav', 'expanded');
        await expectAccessible(page);

        await nav.getByRole('link', { name: 'Inbox' }).click();
        await expect(page).toHaveURL(app.url('/inbox'));
        await expect(nav.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
        await expect(nav.getByRole('link', { name: 'Pipeline' })).not.toHaveAttribute('aria-current', 'page');

        await collapse.click();
        await expect(nav.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
        await expect(page.locator('#app')).toHaveAttribute('data-nav', 'collapsed');
    });

    test('opens your modules, and a placeholder for adding one', async ({ page, app }) => {
        await app.goto('/contacts');
        const nav = page.getByRole('navigation', { name: 'Main' });

        await nav.getByRole('link', { name: 'Deals' }).click();
        await expect(page).toHaveURL(app.url('/modules/deals'));
        await expect(page.getByRole('heading', { name: 'Deals', level: 1 })).toBeVisible();
        await expect(page.getByRole('main')).toContainText('This is where your Deals screen goes.');

        await nav.getByRole('link', { name: 'Add your module' }).click();
        await expect(page.getByRole('heading', { name: 'Add your module', level: 1 })).toBeVisible();
        await expectAccessible(page);

        await app.goto('/modules/nothing-here');
        await expect(page.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
    });
});

test.describe('Command palette', () => {
    test('opens with Cmd/Ctrl+K, finds a contact by name and opens it', async ({ page, app }) => {
        await app.goto('/pipeline');
        await expect(page.locator('dc-pipeline-board')).toBeVisible();

        await page.keyboard.press('ControlOrMeta+K');
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await expect(palette).toBeVisible();
        const input = palette.getByRole('combobox', { name: 'Search contacts or run a command' });
        await expect(input).toBeFocused();
        await expectAccessible(page);

        await input.fill('Grace');
        await expect(palette.getByRole('option', { name: /Grace Hopper/ }).first()).toBeVisible();
        await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Enter');

        await expect(palette).toBeHidden();
        await expect(page).toHaveURL(app.url('/contacts/' + GRACE.contact_id));
        await expect(page.getByRole('heading', { name: 'Grace Hopper', level: 1 })).toBeVisible();
    });

    test('"call <name>" hands the contact to the Dock with its id', async ({ page, app }) => {
        await app.goto('/contacts');
        await app.watchDock();

        await page.getByRole('button', { name: 'Search or run a command' }).click();
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await palette.getByRole('combobox').fill('call ada');
        await expect(palette.getByRole('option', { name: /Call Ada Lovelace/ })).toBeVisible();
        await page.keyboard.press('Enter');

        await expect(palette).toBeHidden();
        await expect.poll(app.dockCalls).toEqual([
            { method: 'dial', target: { contact_id: ADA.contact_id, phone: ADA.main_phone } }
        ]);
    });

    test('moves with the arrow keys, goes to a page, and Esc gives focus back', async ({ page, app }) => {
        await app.goto('/contacts');
        const opener = page.getByRole('button', { name: 'Search or run a command' });
        await opener.click();
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        const input = palette.getByRole('combobox');

        await page.keyboard.press('Escape');
        await expect(palette).toBeHidden();
        await expect(opener).toBeFocused();

        await opener.click();
        await input.fill('go setup');
        await expect(palette.getByRole('option')).toHaveCount(1);
        await expect(palette.getByRole('option', { name: /Go to Setup/ })).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(app.url('/setup'));

        await page.keyboard.press('ControlOrMeta+K');
        await expect(input).toHaveValue('');
        const options = palette.getByRole('option');
        await expect(options.filter({ hasText: 'Go to Contacts' })).toBeVisible();
        await expect(options.first()).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('ArrowDown');
        await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
        await expect(input).toHaveAttribute('aria-activedescendant', await options.nth(1).getAttribute('id'));
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowUp');
        await expect(options.last()).toHaveAttribute('aria-selected', 'true');

        await input.fill('zzz');
        await expect(palette.getByText('No matches for "zzz".')).toBeVisible();
    });
});

test.describe('Embedded layout', () => {
    test('drops the top bar and the navigation, and stays embedded as you move', async ({ page, app }) => {
        await app.goto('/contacts?layout=embedded');

        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Search or run a command' })).toBeHidden();
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
        await expectAccessible(page);

        await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: 'Ada Lovelace' }).click();
        await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
        await expect(page).toHaveURL(new RegExp('/contacts/' + ADA.contact_id + '\\?layout=embedded$'));
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();

        await page.keyboard.press('ControlOrMeta+K');
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
    });
});

test.describe('Dark theme', () => {
    test.use({ colorScheme: 'dark' });

    test('follows the system setting and stays readable', async ({ page, app }) => {
        await app.goto('/contacts/' + ADA.contact_id);
        await expect(page.locator('dc-contact-card')).toContainText('Asked for a callback next week.');

        await expect(page.locator('html')).toHaveAttribute('data-dc-theme', 'dark');
        await expectAccessible(page);

        await page.getByRole('tab', { name: 'Edit' }).click();
        await expectAccessible(page);

        await page.getByRole('button', { name: 'Record consent', exact: true }).first().click();
        await expect(page.getByRole('dialog', { name: 'Record consent' })).toBeVisible();
        await expectAccessible(page);
    });

    test('the pipeline and setup pages stay readable', async ({ page, app }) => {
        await app.goto('/pipeline');
        await expect(page.locator('dc-pipeline-board').getByRole('heading', { name: 'Sales pipeline' })).toBeVisible();
        await page.getByRole('button', { name: 'Activity' }).click();
        await expectAccessible(page);

        await app.goto('/setup');
        await expect(page.locator('ol.checklist')).toBeVisible();
        await expectAccessible(page);
    });
});
