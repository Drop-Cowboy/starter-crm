import { expectAccessible } from '../support/a11y.js';
import { AVAILABLE_NUMBER, BUSINESS_NUMBER } from '../support/data.js';
import { test, expect } from '../support/test.js';

// The pages that are mostly one Building Block: each must render real data
// from the account, with the token for its own purpose and no more.

test.describe('Pipeline page', () => {
    test('shows the first board, and a card opens its contact', async ({ page, app, crm }) => {
        const ada = await crm.person('ada', { stage: 0 });
        const grace = await crm.person('grace', { stage: 1 });
        await app.goto('/pipeline');

        const board = page.locator('dc-pipeline-board');
        await expect(board.getByRole('heading', { name: await crm.boardName() })).toBeVisible();
        await expect(board.getByRole('listitem', { name: (await crm.stage(0)) + ' lane' })).toContainText(ada.full_name);
        await expect(board.getByRole('listitem', { name: (await crm.stage(1)) + ' lane' })).toContainText(grace.full_name);
        await expectAccessible(page);

        await board.getByText(ada.full_name).click();
        await expect(page).toHaveURL(app.url('/contacts/' + ada.contact_id));
    });

    test('moves a card from the keyboard, without dragging', async ({ page, app, dropcowboy, crm }) => {
        const ada = await crm.person('ada', { stage: 0 });
        await app.goto('/pipeline');

        const board = page.locator('dc-pipeline-board');
        const menu = board.getByRole('combobox', { name: 'Move ' + ada.full_name + ' to another stage' });
        await menu.focus();
        await menu.selectOption({ label: await crm.stage(1) });

        const to = board.getByRole('listitem', { name: (await crm.stage(1)) + ' lane' });
        await expect(to).toContainText(ada.full_name);
        await expect(board.getByRole('listitem', { name: (await crm.stage(0)) + ' lane' })).not.toContainText(ada.full_name);
        await expect(menu).toBeFocused();
        await expect(page).toHaveURL(app.url('/pipeline'));

        if (crm.fake) {
            const [move] = dropcowboy.callsTo('POST', '/contact/public/contacts/' + ada.contact_id + '/lists/move');
            expect(move.body).toEqual({ from_list_id: crm.board.stages[0].list_id, to_list_id: crm.board.stages[1].list_id });
            expect(move.status).toBe(200);
        } else {
            await expect.poll(() => crm.stageOf(ada)).toEqual([await crm.stageId(1)]);
        }
    });
});

test.describe('Inbox page', () => {
    test('shows a conversation from the shared inbox', async ({ page, app, crm }) => {
        await app.useBusinessNumber(BUSINESS_NUMBER);
        await app.goto('/inbox');

        // The E2E team has no carrier (BYOC) connected, so Drop Cowboy refuses
        // the inbox token and the page explains why instead. Either outcome
        // is the page working; the conversation itself is checked on the fake.
        if (crm.live) {
            await expect(page.locator('dc-shared-inbox').or(page.locator('.banner'))).toBeVisible();
            await expectAccessible(page);
            return;
        }
        const inbox = page.locator('dc-shared-inbox');
        await expect(inbox.getByRole('region', { name: 'Conversations' })).toContainText('Ada Lovelace');
        await expect(inbox.getByRole('region', { name: 'Conversation with Ada Lovelace' }))
            .toContainText('Can we move our call to Thursday?');
        await expectAccessible(page);
    });
});

test.describe('Campaigns page', () => {
    test('shows campaign results, read-only', async ({ page, app, crm }) => {
        await app.goto('/campaigns');

        const hub = page.getByRole('region', { name: 'Campaign Hub' });
        await expect(hub).toBeVisible();
        if (crm.fake) {
            await expect(hub.getByRole('button', { name: /October renewals/ })).toBeVisible();
            await expect(hub.getByRole('button', { name: /Holiday hours/ })).toBeVisible();
        }

        // A campaigns token can read campaigns but not start, pause or create
        // them, so none of those controls may be offered.
        for (const control of [/^Start/, /^Pause/, /^Stop/, /New/]) {
            await expect(hub.getByRole('button', { name: control })).toHaveCount(0);
        }
        await expectAccessible(page);
    });
});

test.describe('Phone page', () => {
    test('shows the account\'s numbers', async ({ page, app, crm }) => {
        await app.goto('/phone');

        // Without a connected carrier the live team's phone token is refused,
        // and the page says so; the numbers themselves are read on the fake.
        if (crm.live) {
            await expect(page.getByRole('region', { name: 'Phone Hub' }).or(page.locator('.banner'))).toBeVisible();
            await expectAccessible(page);
            return;
        }
        await expect(page.getByRole('region', { name: 'Phone Hub' })).toContainText('+1 (312) 555-0100');
        await expect(page.getByRole('region', { name: 'Get a phone number' })).toBeVisible();
        await expectAccessible(page);
    });

    // @fake-only: never rent numbers against a live account (plan §10.1).
    test('asks before renting a number, and rents only once confirmed @fake-only', async ({ page, app, dropcowboy, target }) => {
        test.skip(target === 'live', '@fake-only: rent/spend skipped against live accounts');
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
