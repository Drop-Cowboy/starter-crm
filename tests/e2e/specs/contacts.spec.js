import { expectAccessible } from '../support/a11y.js';
import { newLivePhone } from '../support/live.js';
import { test, expect } from '../support/test.js';

// The contacts list is the headless REST API: no widget, just fetch calls
// with the contacts token. It sits beside the contact pages and stays put.
//
// These specs run on both targets (the fake Drop Cowboy and, with
// `npm run test:live`, the real one). The `crm` fixture hands each test the
// contacts it needs; assertions on what the browser sent to Drop Cowboy are
// made through `crm.fake`, which only exists on the fake target.

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

/** "(555) 021-0001", the way a person types a US number. */
function national(e164) {
    return '(' + e164.slice(2, 5) + ') ' + e164.slice(5, 8) + '-' + e164.slice(8);
}

test.describe('Contacts list', () => {
    test('lists the account\'s contacts, and asks you to pick one', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts');

        const list = contactList(page);
        await expect(list.getByRole('link').first()).toBeVisible();
        await expect(page.getByRole('main').getByRole('heading', { name: 'Pick a contact' })).toBeVisible();
        if (crm.fake) {
            await expect(list.getByRole('link', { name: ada.full_name })).toBeVisible();
            await expect(list.getByRole('link', { name: 'Grace Hopper' })).toBeVisible();
            await expect(list.getByRole('link', { name: 'Katherine Johnson' })).toBeVisible();
            await expect(page.getByText('Showing 1–3 of 3')).toBeVisible();
        }

        await expectAccessible(page);
    });

    test('stays put while you open contacts, and marks the open one', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        const grace = await crm.person('grace');
        await app.goto('/contacts');
        if (crm.live) await search(page, crm.runId);
        const list = contactList(page);

        await list.getByRole('link', { name: grace.full_name }).click();
        await expect(page).toHaveURL(app.url('/contacts/' + grace.contact_id));
        await expect(page.getByRole('heading', { name: grace.full_name, level: 1 })).toBeVisible();
        await expect(list.getByRole('link', { name: grace.full_name })).toHaveAttribute('aria-current', 'page');

        await list.getByRole('link', { name: ada.full_name }).click();
        await expect(page.getByRole('heading', { name: ada.full_name, level: 1 })).toBeVisible();
        await expect(list.getByRole('link', { name: ada.full_name })).toHaveAttribute('aria-current', 'page');
        await expect(list.getByRole('link', { name: grace.full_name })).not.toHaveAttribute('aria-current', 'page');
    });

    // Drop Cowboy's free-text search matches any word of the term, so the live
    // run searches for one word and asserts on who is, and is not, in the
    // answer. A list of exactly one is only asserted on the fake account,
    // where the test owns every contact.
    test('searches by name, and finds an exact email', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        const grace = await crm.person('grace');
        const katherine = await crm.person('katherine');
        await app.goto('/contacts');
        const list = contactList(page);
        await expect(list.getByRole('link').first()).toBeVisible();

        await search(page, 'Hopper');
        await expect(list.getByRole('link', { name: grace.full_name })).toBeVisible();
        await expect(list.getByRole('link', { name: ada.full_name })).toHaveCount(0);
        await expect(list.getByRole('link', { name: katherine.full_name })).toHaveCount(0);
        if (crm.fake) {
            await expect(list.getByRole('link')).toHaveCount(1);
            expect(crm.fake.callsTo('GET', '/contact/public/contacts').at(-1).query.search_term).toBe('Hopper');
        }

        await search(page, katherine.email);
        await expect(list.getByRole('link', { name: katherine.full_name })).toBeVisible();
        await expect(list.getByRole('link')).toHaveCount(1);
        if (crm.fake) {
            expect(crm.fake.callsTo('GET', '/contact/public/contacts/search').at(-1).query).toEqual({ email: katherine.email });
        }
    });

    test('searches as you type', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        const katherine = await crm.person('katherine');
        await app.goto('/contacts');
        const list = contactList(page);
        await expect(list.getByRole('link').first()).toBeVisible();

        await searchBox(page).pressSequentially('Johnson');
        await expect(list.getByRole('link', { name: katherine.full_name })).toBeVisible();
        await expect(list.getByRole('link', { name: ada.full_name })).toHaveCount(0);
        if (crm.fake) {
            await expect(list.getByRole('link')).toHaveCount(1);
            expect(crm.fake.callsTo('GET', '/contact/public/contacts').at(-1).query.search_term).toBe('Johnson');
        }
    });

    test('says when nothing matches', async ({ page, app, crm }) => {
        await crm.person('ada');
        await app.goto('/contacts');
        await expect(contactList(page).getByRole('link').first()).toBeVisible();

        // A word no contact has. On live it must not contain the run id,
        // which every test contact carries.
        const nobody = crm.live ? 'Babbage' + Math.random().toString(36).slice(2, 10) : 'Babbage';
        await search(page, nobody);
        await expect(page.getByText('No contact matches "' + nobody + '".')).toBeVisible();
        await expect(contactList(page)).toHaveCount(0);
    });

    test('adds a contact on its own page, opens it, and lists it', async ({ page, app, crm }) => {
        crm.sweepRunContacts = true;
        const phone = crm.live ? newLivePhone() : '+15550210001';
        const last = crm.lastName('Jackson');
        await app.goto('/contacts');
        await page.getByRole('region', { name: 'Contacts' }).getByRole('link', { name: 'New' }).click();
        await expect(page).toHaveURL(app.url('/contacts/new'));
        await expect(page.getByRole('heading', { name: 'Add a contact', level: 1 })).toBeVisible();
        await expectAccessible(page);

        await page.getByLabel('First name').fill('Mary');
        await page.getByLabel('Last name').fill(last);
        await page.getByLabel('Phone').fill(national(phone));
        await page.getByLabel('Email').fill(crm.live ? 'mary+' + crm.runId + '@example.com' : 'mary@example.com');
        await page.getByLabel('Company').fill('Wind Tunnel Labs');
        await page.getByRole('button', { name: 'Add contact' }).click();

        await expect(page.getByRole('heading', { name: 'Mary ' + last, level: 1 })).toBeVisible();
        if (crm.fake) {
            const [create] = crm.fake.callsTo('POST', '/contact/public/contacts');
            expect(create.body).toEqual({
                fields: [{ type: 'first_name' }, { type: 'last_name' }, { type: 'email' }, { type: 'main_phone' }, { type: 'company' }],
                values: [['Mary', 'Jackson', 'mary@example.com', phone, 'Wind Tunnel Labs']],
                conflict_mode: 'append',
                fire_webhook_events: true
            });
            const created = [...crm.fake.contacts.values()].find((c) => c.email === 'mary@example.com');
            await expect(page).toHaveURL(app.url('/contacts/' + created.contact_id));
        } else {
            await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
        }
        await expect(contactList(page).getByRole('link', { name: 'Mary ' + last })).toBeVisible();
    });

    test('opens the existing contact instead of adding a duplicate', async ({ page, app, crm }) => {
        const grace = await crm.person('grace');
        await app.goto('/contacts/new');

        await page.getByLabel('First name').fill('Grace');
        await page.getByLabel('Phone').fill(grace.main_phone);
        await page.getByRole('button', { name: 'Add contact' }).click();

        await expect(page).toHaveURL(app.url('/contacts/' + grace.contact_id + '?existing=1'));
        await expect(page.getByText('Already in your contacts')).toBeVisible();
    });

    test('a refused contacts token is refreshed exactly once, then the call succeeds', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts');
        const list = contactList(page);
        await expect(list.getByRole('link').first()).toBeVisible();

        // From here on, count the contacts tokens the page asks the server for.
        const mints = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().endsWith('/api/dropcowboy/token')
                && /"contacts"/.test(request.postData() || '')) mints.push(request.url());
        });

        // The token the page holds stops working, as if it had expired early.
        // On the fake that is a revoked token. Drop Cowboy cannot be told to
        // forget a real token, so on live its answer to the next search is
        // made a 401, once.
        let refused = 0;
        if (crm.fake) {
            crm.fake.revokeTokens('contacts');
        } else {
            await page.route('https://app-api-v2.dropcowboy.com/contact/public/contacts?*', async (route) => {
                const isSearch = route.request().url().includes('search_term=' + encodeURIComponent(ada.search_term));
                if (isSearch && refused === 0) {
                    refused += 1;
                    return route.fulfill({
                        status: 401,
                        contentType: 'application/json',
                        headers: { 'access-control-allow-origin': '*' },
                        body: JSON.stringify({ type: 'https://api-v2.dropcowboy.com/errors/unauthorized', title: 'Unauthorized', status: 401 })
                    });
                }
                return route.fallback();
            });
        }
        // On live, Ada is already in the unfiltered list, so seeing her row
        // does not mean the search was retried. Wait for the retry itself.
        const retried = crm.fake ? null : page.waitForResponse((response) => response.status() === 200
            && response.url().includes('search_term=' + encodeURIComponent(ada.search_term)));
        await search(page, ada.search_term);
        await retried;

        // The retried search came back. On the fake that leaves one row; the
        // live run id also matches the run's delivery probe.
        if (crm.fake) await expect(list.getByRole('link')).toHaveCount(1);
        await expect(list.getByRole('link', { name: ada.full_name })).toBeVisible();
        expect(mints).toHaveLength(1);
        if (crm.fake) {
            const searches = crm.fake.callsTo('GET', '/contact/public/contacts').filter((c) => c.query.search_term === ada.search_term);
            expect(searches.map((c) => c.status)).toEqual([401, 200]);
        } else {
            expect(refused).toBe(1);
        }
    });
});
