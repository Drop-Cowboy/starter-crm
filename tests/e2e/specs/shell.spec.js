import { expectAccessible } from '../support/a11y.js';
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

    test('opens your modules, a placeholder for one not built yet, and one for adding yours', async ({ page, app }) => {
        await app.goto('/contacts');
        const nav = page.getByRole('navigation', { name: 'Main' });

        await nav.getByRole('link', { name: 'Deals' }).click();
        await expect(page).toHaveURL(app.url('/modules/deals'));
        await expect(page.getByRole('heading', { name: 'Deals', level: 1 })).toBeVisible();
        await expect(page.getByRole('form', { name: 'Add a deal' })).toBeVisible();

        await nav.getByRole('link', { name: 'Tickets' }).click();
        await expect(page.getByRole('heading', { name: 'Tickets', level: 1 })).toBeVisible();
        await expect(page.getByRole('main')).toContainText('This is where your Tickets screen goes.');

        await nav.getByRole('link', { name: 'Add your module' }).click();
        await expect(page.getByRole('heading', { name: 'Add your module', level: 1 })).toBeVisible();
        await expectAccessible(page);

        await app.goto('/modules/nothing-here');
        await expect(page.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
    });
});

test.describe('Command palette', () => {
    test('opens with Cmd/Ctrl+K, finds a contact by name and opens it', async ({ page, app, crm }) => {
        const grace = await crm.person('grace');
        await app.goto('/pipeline');
        await expect(page.locator('dc-pipeline-board')).toBeVisible();

        await page.keyboard.press('ControlOrMeta+K');
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await expect(palette).toBeVisible();
        const input = palette.getByRole('combobox', { name: 'Search contacts or run a command' });
        await expect(input).toBeFocused();
        await expectAccessible(page);

        await input.fill(crm.live ? grace.search_term : 'Grace');
        const option = palette.getByRole('option', { name: new RegExp(grace.full_name) }).first();
        await expect(option).toBeVisible();
        await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
        await option.click();

        await expect(palette).toBeHidden();
        await expect(page).toHaveURL(app.url('/contacts/' + grace.contact_id));
        await expect(page.getByRole('heading', { name: grace.full_name, level: 1 })).toBeVisible();
    });

    // @fake-only: the Dock needs a calling token; the E2E team has no carrier.
    test('"call <name>" hands the contact to the Dock with its id @fake-only', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts');
        await app.watchDock();

        await page.getByRole('button', { name: 'Search or run a command' }).click();
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await palette.getByRole('combobox').fill('call ' + (crm.live ? ada.search_term : 'ada'));
        const option = palette.getByRole('option', { name: new RegExp('Call ' + ada.full_name) });
        await expect(option).toBeVisible();
        await option.click();

        await expect(palette).toBeHidden();
        await expect.poll(app.dockCalls).toEqual([
            { method: 'dial', target: { contact_id: ada.contact_id, phone: ada.main_phone } }
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
    test('drops the top bar and the navigation, and stays embedded as you move', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts?layout=embedded');

        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: ada.full_name })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Search or run a command' })).toBeHidden();
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
        await expectAccessible(page);

        await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: ada.full_name }).click();
        await expect(page.getByRole('heading', { name: ada.full_name, level: 1 })).toBeVisible();
        await expect(page).toHaveURL(new RegExp('/contacts/' + ada.contact_id + '\\?layout=embedded$'));
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();

        await page.keyboard.press('ControlOrMeta+K');
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
    });
});

test.describe('Theme button', () => {
    test.use({ colorScheme: 'light' });

    test('moves through system, light and dark, and remembers the choice', async ({ page, app }) => {
        await app.goto('/contacts');
        const html = page.locator('html');
        await expect(html).toHaveAttribute('data-dc-theme', 'light');
        await expect(html).not.toHaveAttribute('data-theme', /.*/);

        await page.getByRole('button', { name: 'Theme: System. Switch to Light' }).click();
        await expect(html).toHaveAttribute('data-theme', 'light');

        await page.getByRole('button', { name: 'Theme: Light. Switch to Dark' }).click();
        await expect(html).toHaveAttribute('data-theme', 'dark');
        await expect(html).toHaveAttribute('data-dc-theme', 'dark');
        await expectAccessible(page);

        await page.reload();
        await expect(page.getByRole('button', { name: 'Theme: Dark. Switch to System' })).toBeVisible();
        await expect(html).toHaveAttribute('data-dc-theme', 'dark');

        await page.getByRole('button', { name: 'Theme: Dark. Switch to System' }).click();
        await expect(html).not.toHaveAttribute('data-theme', /.*/);
        await expect(html).toHaveAttribute('data-dc-theme', 'light');
    });
});

test.describe('Dark theme', () => {
    test.use({ colorScheme: 'dark' });

    test('follows the system setting and stays readable', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        await expect(page.locator('dc-contact-card')).toContainText(ada.full_name);

        await expect(page.locator('html')).toHaveAttribute('data-dc-theme', 'dark');
        await expectAccessible(page);

        await page.getByRole('tab', { name: 'Edit' }).click();
        await expectAccessible(page);

        await page.getByRole('button', { name: 'Record consent', exact: true }).first().click();
        await expect(page.getByRole('dialog', { name: 'Record consent' })).toBeVisible();
        await expectAccessible(page);
    });

    test('the pipeline and setup pages stay readable', async ({ page, app, crm }) => {
        await app.goto('/pipeline');
        await expect(page.locator('dc-pipeline-board').getByRole('heading', { name: await crm.boardName() })).toBeVisible();
        await page.getByRole('button', { name: 'Activity' }).click();
        await expectAccessible(page);

        await app.goto('/setup');
        await expect(page.locator('ol.checklist').first()).toBeVisible();
        await expectAccessible(page);
    });
});
