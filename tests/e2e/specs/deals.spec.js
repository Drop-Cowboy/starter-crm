import { expectAccessible } from '../support/a11y.js';
import { test, expect } from '../support/test.js';

// Deals is the example of a module of your own: its data lives on the starter
// server, behind /api/modules/deals, and each deal can point at a Drop Cowboy
// contact. The same specs run against the Node and Python servers and both
// front-ends.

/** Titles must be unique: the server keeps deals between tests. */
function title(label) {
    return label + ' ' + Math.random().toString(36).slice(2, 8);
}

function deal(page, name) {
    return page.locator('article.deal').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function addDeal(page, { name, amount, stage, contact }) {
    const form = page.getByRole('form', { name: 'Add a deal' });
    await form.getByLabel('Title').fill(name);
    if (amount) await form.getByLabel('Amount (USD)').fill(amount);
    if (stage) await form.getByLabel('Stage').selectOption({ label: stage });
    if (contact) await form.getByLabel('Contact').selectOption({ label: contact });
    await form.getByRole('button', { name: 'Add deal' }).click();
}

test.describe('Deals', () => {
    test('adds a deal, moves it through the stages, archives it and deletes it', async ({ page, app }) => {
        const name = title('Renewal');
        await app.goto('/modules/deals');
        await expect(page.getByRole('heading', { name: 'Deals', level: 1 })).toBeVisible();

        await addDeal(page, { name, amount: '1250.50', stage: 'Proposal' });
        const row = deal(page, name);
        await expect(row).toBeVisible();
        await expect(row).toContainText('$1,250.50');
        await expect(row.getByLabel('Stage for ' + name)).toHaveValue('proposal');
        await expect(page.getByRole('form', { name: 'Add a deal' }).getByLabel('Title')).toHaveValue('');
        await expectAccessible(page);

        await row.getByLabel('Stage for ' + name).selectOption({ label: 'Won' });
        await expect(app.toasts).toContainText(name + ' is now Won');

        await page.reload();
        await expect(deal(page, name).getByLabel('Stage for ' + name)).toHaveValue('won');

        await deal(page, name).getByRole('button', { name: 'Archive' }).click();
        await expect(deal(page, name)).toHaveCount(0);
        await page.getByLabel('Show archived').check();
        await expect(deal(page, name)).toHaveClass(/archived/);
        await deal(page, name).getByRole('button', { name: 'Restore' }).click();
        await page.getByLabel('Show archived').uncheck();
        await expect(deal(page, name)).toBeVisible();

        await deal(page, name).getByRole('button', { name: 'Delete ' + name }).click();
        await expect(deal(page, name)).toHaveCount(0);
        await expect(app.toasts).toContainText('Deleted ' + name);
    });

    test('filters the list by stage', async ({ page, app }) => {
        const lead = title('Lead only');
        const won = title('Won only');
        await app.goto('/modules/deals');
        await addDeal(page, { name: lead, stage: 'Lead' });
        await expect(deal(page, lead)).toBeVisible();
        await addDeal(page, { name: won, stage: 'Won' });
        await expect(deal(page, won)).toBeVisible();

        await page.getByLabel('Filter by stage').selectOption({ label: 'Won' });
        await expect(deal(page, won)).toBeVisible();
        await expect(deal(page, lead)).toHaveCount(0);
    });

    test('explains a number it cannot read instead of sending it', async ({ page, app }) => {
        const name = title('Typo');
        await app.goto('/modules/deals');
        await addDeal(page, { name, amount: 'a lot' });
        await expect(page.getByRole('alert')).toContainText('enter a number');
        await expect(deal(page, name)).toHaveCount(0);
    });

    test('links a deal to a contact and opens their card', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        const name = title('Ada account');
        await app.goto('/modules/deals');
        await expect(page.getByRole('form', { name: 'Add a deal' }).getByLabel('Contact').locator('option', { hasText: ada.full_name })).toHaveCount(1);
        await addDeal(page, { name, contact: ada.full_name });

        const row = deal(page, name);
        await expect(row.getByRole('link', { name: ada.full_name })).toHaveAttribute('href', new RegExp(ada.contact_id));
        await row.getByRole('button', { name: 'Contact card' }).click();
        await expect(page.getByRole('region', { name: 'Contact card for ' + name })).toBeVisible();
    });

    test('archives the deals of a deleted contact @fake-only', async ({ page, app, crm }) => {
        test.skip(!crm.fake, 'Only the fake account can delete a contact on demand.');
        const grace = await crm.person('grace');
        const name = title('Grace account');
        await app.goto('/modules/deals');
        await expect(page.getByRole('form', { name: 'Add a deal' }).getByLabel('Contact').locator('option', { hasText: grace.full_name })).toHaveCount(1);
        await addDeal(page, { name, contact: grace.full_name });
        await expect(deal(page, name)).not.toHaveClass(/archived/);

        await crm.triggerWebhook('contact.deleted', grace);

        // The page reloads itself when the webhook reaches it. Ask for archived deals to see the result.
        await page.getByLabel('Show archived').check();
        await expect(deal(page, name)).toHaveClass(/archived/);
        await expect(deal(page, name)).toContainText('its contact was deleted in Drop Cowboy');
    });
});
