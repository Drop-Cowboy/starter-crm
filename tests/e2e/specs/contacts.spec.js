import { expectAccessible } from '../support/a11y.js';
import { ADA, GRACE, KATHERINE } from '../support/data.js';
import { test, expect } from '../support/test.js';

// The contacts list is the headless REST API: no widget, just fetch calls
// with the contacts token. It sits beside the contact pages and stays put.

function contactList(page) {
    return page.getByRole('list', { name: 'Contacts' });
}

function searchBox(page) {
    return page.getByRole('searchbox', { name: 'Search contacts', exact: true });
}

async function search(page, text) {
    await searchBox(page).fill(text);
    await searchBox(page).press('Enter');
}

test.describe('Contacts list', () => {
    test('lists the account\'s contacts, and asks you to pick one', async ({ page, app }) => {
        await app.goto('/contacts');

        const list = contactList(page);
        await expect(list.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();
        await expect(list.getByRole('link', { name: 'Grace Hopper' })).toBeVisible();
        await expect(list.getByRole('link', { name: 'Katherine Johnson' })).toBeVisible();
        await expect(page.getByText('Showing 1–3 of 3')).toBeVisible();
        await expect(page.getByRole('main').getByRole('heading', { name: 'Pick a contact' })).toBeVisible();

        await expectAccessible(page);
    });

    test('stays put while you open contacts, and marks the open one', async ({ page, app }) => {
        await app.goto('/contacts');
        const list = contactList(page);

        await list.getByRole('link', { name: 'Grace Hopper' }).click();
        await expect(page).toHaveURL(app.url('/contacts/' + GRACE.contact_id));
        await expect(page.getByRole('heading', { name: 'Grace Hopper', level: 1 })).toBeVisible();
        await expect(list.getByRole('link', { name: 'Grace Hopper' })).toHaveAttribute('aria-current', 'page');

        await list.getByRole('link', { name: 'Ada Lovelace' }).click();
        await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
        await expect(list.getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute('aria-current', 'page');
        await expect(list.getByRole('link', { name: 'Grace Hopper' })).not.toHaveAttribute('aria-current', 'page');
    });

    test('searches by name, and finds an exact email', async ({ page, app, dropcowboy }) => {
        await app.goto('/contacts');
        const list = contactList(page);
        await expect(list.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();

        await search(page, 'Hopper');
        await expect(list.getByRole('link')).toHaveCount(1);
        await expect(list.getByRole('link', { name: 'Grace Hopper' })).toBeVisible();
        expect(dropcowboy.callsTo('GET', '/contact/public/contacts').at(-1).query.search_term).toBe('Hopper');

        await search(page, KATHERINE.email);
        await expect(list.getByRole('link', { name: 'Katherine Johnson' })).toBeVisible();
        await expect(list.getByRole('link')).toHaveCount(1);
        expect(dropcowboy.callsTo('GET', '/contact/public/contacts/search').at(-1).query).toEqual({ email: KATHERINE.email });
    });

    test('searches as you type', async ({ page, app, dropcowboy }) => {
        await app.goto('/contacts');
        const list = contactList(page);
        await expect(list.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();

        await searchBox(page).pressSequentially('Johnson');
        await expect(list.getByRole('link')).toHaveCount(1);
        await expect(list.getByRole('link', { name: 'Katherine Johnson' })).toBeVisible();
        expect(dropcowboy.callsTo('GET', '/contact/public/contacts').at(-1).query.search_term).toBe('Johnson');
    });

    test('says when nothing matches', async ({ page, app }) => {
        await app.goto('/contacts');
        await expect(contactList(page).getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();

        await search(page, 'Babbage');
        await expect(page.getByText('No contact matches "Babbage".')).toBeVisible();
        await expect(contactList(page)).toHaveCount(0);
    });

    test('adds a contact on its own page, opens it, and lists it', async ({ page, app, dropcowboy }) => {
        await app.goto('/contacts');
        await page.getByRole('region', { name: 'Contacts' }).getByRole('link', { name: 'New' }).click();
        await expect(page).toHaveURL(app.url('/contacts/new'));
        await expect(page.getByRole('heading', { name: 'Add a contact', level: 1 })).toBeVisible();
        await expectAccessible(page);

        await page.getByLabel('First name').fill('Mary');
        await page.getByLabel('Last name').fill('Jackson');
        await page.getByLabel('Phone').fill('(312) 555-0145');
        await page.getByLabel('Email').fill('mary@example.com');
        await page.getByLabel('Company').fill('Wind Tunnel Labs');
        await page.getByRole('button', { name: 'Add contact' }).click();

        await expect(page.getByRole('heading', { name: 'Mary Jackson', level: 1 })).toBeVisible();
        const [create] = dropcowboy.callsTo('POST', '/contact/public/contacts');
        expect(create.body).toEqual({
            fields: [{ type: 'first_name' }, { type: 'last_name' }, { type: 'email' }, { type: 'main_phone' }, { type: 'company' }],
            values: [['Mary', 'Jackson', 'mary@example.com', '+13125550145', 'Wind Tunnel Labs']],
            conflict_mode: 'append',
            fire_webhook_events: true
        });
        const created = [...dropcowboy.contacts.values()].find((c) => c.email === 'mary@example.com');
        await expect(page).toHaveURL(app.url('/contacts/' + created.contact_id));
        await expect(contactList(page).getByRole('link', { name: 'Mary Jackson' })).toBeVisible();
    });

    test('opens the existing contact instead of adding a duplicate', async ({ page, app }) => {
        await app.goto('/contacts/new');

        await page.getByLabel('First name').fill('Grace');
        await page.getByLabel('Phone').fill(GRACE.main_phone);
        await page.getByRole('button', { name: 'Add contact' }).click();

        await expect(page).toHaveURL(app.url('/contacts/' + GRACE.contact_id + '?existing=1'));
        await expect(page.getByText('Already in your contacts')).toBeVisible();
    });

    test('a refused contacts token is refreshed exactly once, then the call succeeds', async ({ page, app, dropcowboy }) => {
        await app.goto('/contacts');
        const list = contactList(page);
        await expect(list.getByRole('link', { name: ADA.first_name + ' ' + ADA.last_name })).toBeVisible();
        const mintsBefore = dropcowboy.mintsFor('contacts').length;

        // The token the page holds stops working, as if it had expired early.
        dropcowboy.revokeTokens('contacts');
        await search(page, 'Lovelace');

        await expect(list.getByRole('link')).toHaveCount(1);
        await expect(list.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();
        expect(dropcowboy.mintsFor('contacts').length - mintsBefore).toBe(1);
        const searches = dropcowboy.callsTo('GET', '/contact/public/contacts').filter((c) => c.query.search_term === 'Lovelace');
        expect(searches.map((c) => c.status)).toEqual([401, 200]);
    });
});
