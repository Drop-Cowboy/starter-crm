import { expectAccessible } from '../support/a11y.js';
import { ADA, BUSINESS_NUMBER } from '../support/data.js';
import { test, expect } from '../support/test.js';

// What the user sees when Drop Cowboy says no. Each refusal should explain
// itself and leave the rest of the CRM working.

test.describe('A team with no carrier connected', () => {
    test.beforeEach(({ dropcowboy }) => {
        // Drop Cowboy refuses calling tokens until a carrier (BYOC) is connected.
        dropcowboy.refuseMints('dialer:webrtc', 'byoc_required');
    });

    test('still lists contacts, and explains why calling is unavailable', async ({ page, app, dropcowboy }) => {
        await app.goto('/contacts');

        await expect(page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();
        const banner = page.locator('.banner');
        await expect(banner).toContainText('Connect your carrier');
        await expect(banner.getByRole('link', { name: 'Setup: carrier' })).toHaveAttribute('href', app.path('/setup#connect_byoc'));
        expect(dropcowboy.mintsFor('dialer:webrtc contacts').length).toBeGreaterThan(0);
        await expectAccessible(page);
    });

    test('still shows a contact and its card', async ({ page, app }) => {
        await app.goto('/contacts/' + ADA.contact_id);

        await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
        await expect(page.locator('dc-contact-card')).toContainText('Asked for a callback next week.');
        await expect(page.locator('.banner')).toContainText('Connect your carrier');
    });

    test('explains it once on the inbox, and does not ask for a business number', async ({ page, app }) => {
        await app.goto('/inbox');

        await expect(page.locator('.banner')).toContainText('Connect your carrier');
        const main = page.getByRole('main');
        await expect(main).toContainText('Calling and texting are off');
        await expect(main.getByRole('link', { name: 'Setup: carrier' })).toHaveAttribute('href', app.path('/setup#connect_byoc'));
        await expect(page.getByText('Connect your carrier', { exact: true })).toHaveCount(1);
        await expect(main).not.toContainText('Set a business number');
        await expectAccessible(page);
    });
});

test.describe('Texting a contact without consent', () => {
    test('shows the consent guidance', async ({ page, app, dropcowboy }) => {
        dropcowboy.refuseTexts('consent_required');
        await app.useBusinessNumber(BUSINESS_NUMBER);
        await app.goto('/contacts/' + ADA.contact_id);

        await page.getByRole('button', { name: 'Text', exact: true }).first().click();
        const dock = page.locator('dc-dock');
        await dock.getByRole('textbox', { name: 'Message' }).fill('Does Thursday at 10 work?');
        await dock.getByRole('button', { name: 'Send' }).click();

        await expect.poll(() => dropcowboy.callsTo('POST', '/phone/embed/sms').length).toBe(1);
        const [send] = dropcowboy.callsTo('POST', '/phone/embed/sms');
        expect(send.status).toBe(403);
        expect(send.body).toMatchObject({
            contact_id: ADA.contact_id,
            phone_number: ADA.main_phone,
            caller_id: BUSINESS_NUMBER,
            sms_body: 'Does Thursday at 10 work?'
        });

        // The Dock says why, and so does the starter's own notice.
        await expect(dock.getByRole('alert')).toContainText('Consent required');
        await expect(app.toasts).toContainText('Consent needed');
        await expect(app.toasts).toContainText('Use existing contact consent');
    });
});
