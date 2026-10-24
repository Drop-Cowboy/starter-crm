import crypto from 'node:crypto';
import { expectAccessible } from '../support/a11y.js';
import { BUSINESS_NUMBER } from '../support/data.js';
import { test, expect } from '../support/test.js';

// The contact card has Call and Text buttons of its own, further down the
// page; these are the starter's, in the contact's header.
function appButton(page, name) {
    return page.getByRole('button', { name, exact: true }).first();
}

async function openTab(page, name) {
    await page.getByRole('tab', { name }).click();
    await expect(page.getByRole('tabpanel', { name })).toBeVisible();
}

// One contact: its fields come from the REST API, the Drop Cowboy contact
// card shows its timeline, and Call / Text hand the contact to the Dock.

test.describe('Contact page', () => {
    test('shows the Drop Cowboy contact card with its timeline', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);

        await expect(page.getByRole('heading', { name: ada.full_name, level: 1 })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
        const card = page.getByRole('region', { name: 'Drop Cowboy contact card' }).locator('dc-contact-card');
        await expect(card).toContainText(ada.full_name);
        if (crm.fake) await expect(card).toContainText('Asked for a callback next week.');
        await expect(page.getByRole('tabpanel', { name: 'Overview' }).getByText('<dc-contact-card>')).toBeVisible();

        await expectAccessible(page);
    });

    test('moves between tabs from the keyboard', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        await expect(page.getByRole('main')).toBeFocused();
        const overview = page.getByRole('tab', { name: 'Overview' });
        await overview.focus();

        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('tab', { name: 'Activity' })).toBeFocused();
        await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('tabpanel', { name: 'Activity' })).toBeVisible();
        await expect(page.getByRole('tabpanel', { name: 'Overview' })).toBeHidden();

        await page.keyboard.press('End');
        await expect(page.getByRole('tab', { name: 'Edit' })).toBeFocused();
        await expect(page.getByRole('tabpanel', { name: 'Edit' })).toBeVisible();

        await page.keyboard.press('ArrowRight');
        await expect(overview).toBeFocused();
        await expect(overview).toHaveAttribute('aria-selected', 'true');

        await page.keyboard.press('ArrowLeft');
        await expect(page.getByRole('tab', { name: 'Edit' })).toBeFocused();

        await page.keyboard.press('Home');
        await expect(overview).toBeFocused();
        await expect(overview).toHaveAttribute('tabindex', '0');
        await expect(page.getByRole('tab', { name: 'Edit' })).toHaveAttribute('tabindex', '-1');
        // The card stays mounted while another tab is open.
        await expect(page.locator('dc-contact-card')).toContainText(ada.full_name);
    });

    test('saves only the fields that changed, as top-level standard fields', async ({ page, app, dropcowboy, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        await openTab(page, 'Edit');

        await page.getByLabel('Company').fill('Difference Engines');
        await page.getByRole('button', { name: 'Save changes' }).click();

        await expect(app.toasts).toContainText(`Saved ${ada.full_name}`);
        if (crm.fake) {
            const [save] = dropcowboy.callsTo('PUT', '/contact/public/contacts/' + ada.contact_id);
            expect(save.body).toEqual({ company: 'Difference Engines' });
        }
        expect((await crm.contact(ada)).company).toBe('Difference Engines');
        await expect(page.locator('header.profile')).toContainText('Difference Engines');
        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: ada.full_name })).toContainText('Difference Engines');
    });

    test('records the consent a contact gave, one record per channel, in a sheet', async ({ page, app, dropcowboy, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        const opener = appButton(page, 'Record consent');
        await opener.click();

        const sheet = page.getByRole('dialog', { name: 'Record consent' });
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText(`for ${ada.full_name}`);
        await expectAccessible(page);
        const form = sheet.getByRole('form', { name: 'Record consent' });

        await form.getByRole('button', { name: 'Record consent' }).click();
        await expect(form.getByRole('alert')).toContainText('Choose texts, calls, or both.');
        expect(dropcowboy.callsTo('POST', '/contact/public/contacts/' + ada.contact_id + '/consent')).toHaveLength(0);

        await form.getByLabel('Texts').check();
        await form.getByLabel('Calls').check();
        await form.getByLabel('How they agreed').selectOption('phone');
        await form.getByLabel('What they agreed to').fill('Yes, you can text and call me about my order.');
        await form.getByRole('button', { name: 'Record consent' }).click();

        await expect(app.toasts).toContainText(`Recorded consent for ${ada.full_name}`);
        await expect(sheet).toBeHidden();
        await expect(opener).toBeFocused();
        if (crm.fake) {
            const sends = dropcowboy.callsTo('POST', '/contact/public/contacts/' + ada.contact_id + '/consent');
            expect(sends.map((s) => s.body)).toEqual([
                { consent_type: 'sms_optin', phone_number: ada.main_phone, consent_text: 'Yes, you can text and call me about my order.', consent_method: 'phone' },
                { consent_type: 'tcpa_optin', phone_number: ada.main_phone, consent_text: 'Yes, you can text and call me about my order.', consent_method: 'phone' }
            ]);
        }
        expect(await crm.contact(ada)).toMatchObject({ has_sms_consent: true, has_tcpa_consent: true });

        await opener.click();
        await expect(sheet.getByLabel('What they agreed to')).toHaveValue('');
    });

    test('the consent sheet closes on Esc and from the Consent tab', async ({ page, app, dropcowboy, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        const sheet = page.getByRole('dialog', { name: 'Record consent' });

        await openTab(page, 'Consent');
        const tabButton = page.getByRole('tabpanel', { name: 'Consent' }).getByRole('button', { name: 'Record consent' });
        await tabButton.click();
        await expect(sheet).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await expect(tabButton).toBeFocused();

        await tabButton.click();
        await sheet.getByRole('button', { name: 'Cancel' }).click();
        await expect(sheet).toBeHidden();
        await expect(tabButton).toBeFocused();
        expect(dropcowboy.callsTo('POST', '/contact/public/contacts/' + ada.contact_id + '/consent')).toHaveLength(0);
    });

    test('asks before deleting, and deletes only once confirmed', async ({ page, app, dropcowboy, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        await expect(page.getByRole('heading', { name: ada.full_name, level: 1 })).toBeVisible();
        await openTab(page, 'Edit');
        const grace = await crm.person('grace');
        const deleteButton = page.getByRole('tabpanel', { name: 'Edit' }).getByRole('button', { name: 'Delete contact' });

        await deleteButton.click();
        const dialog = page.getByRole('dialog', { name: `Delete ${ada.full_name}?` });
        await expect(dialog).toBeVisible();
        await expectAccessible(page);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        expect(await crm.contact(ada)).not.toBeNull();

        await deleteButton.click();
        await dialog.getByRole('button', { name: 'Delete contact' }).click();

        await expect(page).toHaveURL(app.url('/contacts'));
        await expect(app.toasts).toContainText(`Deleted ${ada.full_name}`);
        expect(await crm.contact(ada)).toBeNull();
        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: grace.full_name })).toBeVisible();
        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: ada.full_name })).toHaveCount(0);
    });

    // @fake-only: this checks the hand-off to the Dock, not the call; the live
    // call to a 555 test number is in sandbox.spec.js.
    test('Call hands the contact to the Dock by id and number @fake-only', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        await app.watchDock();

        await appButton(page, 'Call').click();

        await expect.poll(app.dockCalls).toEqual([
            { method: 'dial', target: { contact_id: ada.contact_id, phone: ada.main_phone } }
        ]);
    });

    // @fake-only: same as Call; the live text to a 555 test number is in sandbox.spec.js.
    test('Text hands the contact to the Dock once a business number is set @fake-only', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.useBusinessNumber(BUSINESS_NUMBER);
        await app.goto('/contacts/' + ada.contact_id);
        await app.watchDock();

        await appButton(page, 'Text').click();

        await expect.poll(app.dockCalls).toEqual([
            { method: 'text', target: { contact_id: ada.contact_id, phone: ada.main_phone } }
        ]);
    });

    // @fake-only: the contact has a real-format number, which the live suite
    // never puts on an account. A 555 test number needs no business number.
    test('Text to a real number explains that a business number is needed first @fake-only', async ({ page, app, crm }) => {
        const uk = await crm.extraPerson({
            contact_id: crypto.randomUUID(),
            first_name: 'Rosalind',
            last_name: 'Franklin',
            // Ofcom's drama range: reserved, never assigned to a phone.
            main_phone: '+447700900123',
            email: 'rosalind@example.com',
            has_sms_consent: true,
            created_at: 1791301200000
        });
        await app.goto('/contacts/' + uk.contact_id);
        await app.watchDock();

        await appButton(page, 'Text').click();

        await expect(page.getByRole('main')).toContainText('business number');
        expect(await app.dockCalls()).toEqual([]);
    });

    test('Text to a 555 test number goes to the Dock with no business number', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        await app.watchDock();

        await appButton(page, 'Text').click();

        await expect.poll(app.dockCalls).toEqual([
            { method: 'text', target: { contact_id: ada.contact_id, phone: ada.main_phone } }
        ]);
    });

    test('a wide screen shows the contact\'s details beside it, and the panel can be hidden', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await page.setViewportSize({ width: 1440, height: 900 });
        await app.goto('/contacts/' + ada.contact_id);

        const context = page.getByRole('complementary', { name: 'Context' });
        await expect(context).toBeVisible();
        await expect(context.getByRole('heading', { name: 'Details' })).toBeVisible();
        await expect(context).toContainText('Do not call:');
        await expect(context.getByRole('link', { name: 'Open in Pipeline' })).toBeVisible();

        await page.getByRole('button', { name: 'Hide context panel' }).click();
        await expect(context).toBeHidden();
        const show = page.getByRole('button', { name: 'Show context panel' });
        await expect(show).toHaveAttribute('aria-expanded', 'false');

        await show.click();
        await expect(context).toBeVisible();
        await expect(page.getByRole('button', { name: 'Hide context panel' })).toHaveAttribute('aria-expanded', 'true');

        await context.getByRole('button', { name: 'Close panel' }).click();
        await expect(context).toBeHidden();
        await expect(page.getByRole('button', { name: 'Show context panel' })).toBeFocused();
        await expectAccessible(page);
    });
});
