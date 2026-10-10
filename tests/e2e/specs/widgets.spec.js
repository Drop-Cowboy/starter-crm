import { expectAccessible } from '../support/a11y.js';
import { ADA, AVAILABLE_NUMBER, BOARD, BUSINESS_NUMBER } from '../support/data.js';
import { test, expect } from '../support/test.js';

// The pages that are mostly one Building Block: each must render real data
// from the account, with the token for its own purpose and no more.

test.describe('Pipeline page', () => {
    test('shows the first board, and a card opens its contact', async ({ page, app }) => {
        await app.goto('/pipeline');

        const board = page.locator('dc-pipeline-board');
        await expect(board.getByRole('heading', { name: 'Sales pipeline' })).toBeVisible();
        await expect(board.getByRole('listitem', { name: 'New lead lane' })).toContainText('Ada Lovelace');
        await expect(board.getByRole('listitem', { name: 'Qualified lane' })).toContainText('Grace Hopper');
        await expectAccessible(page);

        await board.getByText('Ada Lovelace').click();
        await expect(page).toHaveURL(app.url('/contacts/' + ADA.contact_id));
    });

    test('moves a card from the keyboard, without dragging', async ({ page, app, dropcowboy }) => {
        await app.goto('/pipeline');

        const board = page.locator('dc-pipeline-board');
        const menu = board.getByRole('combobox', { name: 'Move Ada Lovelace to another stage' });
        await menu.focus();
        await menu.selectOption({ label: 'Qualified' });

        await expect(board.getByRole('listitem', { name: 'Qualified lane' })).toContainText('Ada Lovelace');
        await expect(board.getByRole('listitem', { name: 'New lead lane' })).not.toContainText('Ada Lovelace');
        await expect(menu).toBeFocused();
        await expect(page).toHaveURL(app.url('/pipeline'));

        const [move] = dropcowboy.callsTo('POST', '/contact/public/contacts/' + ADA.contact_id + '/lists/move');
        expect(move.body).toEqual({ from_list_id: BOARD.stages[0].list_id, to_list_id: BOARD.stages[1].list_id });
        expect(move.status).toBe(200);
    });
});

test.describe('Inbox page', () => {
    test('shows a conversation from the shared inbox', async ({ page, app }) => {
        await app.useBusinessNumber(BUSINESS_NUMBER);
        await app.goto('/inbox');

        const inbox = page.locator('dc-shared-inbox');
        await expect(inbox.getByRole('region', { name: 'Conversations' })).toContainText('Ada Lovelace');
        await expect(inbox.getByRole('region', { name: 'Conversation with Ada Lovelace' }))
            .toContainText('Can we move our call to Thursday?');
        await expectAccessible(page);
    });
});

test.describe('Campaigns page', () => {
    test('shows campaign results, read-only', async ({ page, app }) => {
        await app.goto('/campaigns');

        const hub = page.getByRole('region', { name: 'Campaign Hub' });
        await expect(hub.getByRole('button', { name: /October renewals/ })).toBeVisible();
        await expect(hub.getByRole('button', { name: /Holiday hours/ })).toBeVisible();

        // A campaigns token can read campaigns but not start, pause or create
        // them, so none of those controls may be offered.
        for (const control of [/^Start/, /^Pause/, /^Stop/, /New/]) {
            await expect(hub.getByRole('button', { name: control })).toHaveCount(0);
        }
        await expectAccessible(page);
    });
});

test.describe('Phone page', () => {
    test('shows the account\'s numbers', async ({ page, app }) => {
        await app.goto('/phone');

        await expect(page.getByRole('region', { name: 'Phone Hub' })).toContainText('+1 (312) 555-0100');
        await expect(page.getByRole('region', { name: 'Get a phone number' })).toBeVisible();
        await expectAccessible(page);
    });

    test('asks before renting a number, and rents only once confirmed', async ({ page, app, dropcowboy }) => {
        await app.goto('/phone');
        const picker = page.getByRole('region', { name: 'Get a phone number' });
        await picker.getByRole('textbox', { name: 'Area code or city' }).fill('312');
        await picker.getByRole('button', { name: 'Search' }).click();
        await expect(picker).toContainText('+1 (312) 555-0177');

        const questions = [];
        page.once('dialog', (dialog) => {
            questions.push(dialog.message());
            dialog.dismiss();
        });
        await picker.getByRole('button', { name: 'Get it' }).click();
        await expect.poll(() => questions).toEqual(['Get +1 (312) 555-0177 on your account? It costs $1.50/mo.']);
        expect(dropcowboy.callsTo('POST', '/phone/public/numbers/rent')).toEqual([]);

        page.once('dialog', (dialog) => dialog.accept());
        await picker.getByRole('button', { name: 'Get it' }).click();
        await expect.poll(() => dropcowboy.callsTo('POST', '/phone/public/numbers/rent').length).toBe(1);
        expect(dropcowboy.callsTo('POST', '/phone/public/numbers/rent')[0].body.number).toBe(AVAILABLE_NUMBER.phone_number);
        await expect(app.toasts).toContainText('Number added');
    });
});
