import { expectAccessible } from '../support/a11y.js';
import { test, expect } from '../support/test.js';
import { deliverWebhook } from '../support/webhook.js';

// Drop Cowboy POSTs signed webhooks to the server; the server checks the
// signature and pushes each event to open pages over Server-Sent Events.
// On pages without the context rail, the Activity button opens them in a
// drawer.

// The event each target can raise on demand. The fake account can send any
// event; the live account sends contact.updated when a contact is changed.
function kindFor(crm) {
    return crm.live
        ? { event: 'contact.updated', title: 'Contact updated' }
        : { event: 'contact.msg.received', title: 'Text received' };
}

/** Raises the event about `person`, as signed by Drop Cowboy (live) or the test (fake). */
function raise(crm, person, body) {
    return crm.triggerWebhook(kindFor(crm).event, person, { from: person.main_phone, body });
}

/** The feed entries about one contact. */
function itemsAbout(feed, person) {
    return feed.getByRole('listitem').filter({ has: feed.page().locator('a[href*="' + person.contact_id + '"]') });
}

test.describe('Activity', () => {
    test('shows a signed webhook as it arrives', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        const kind = kindFor(crm);
        await app.goto('/contacts');
        await page.getByRole('button', { name: 'Activity' }).click();
        const drawer = page.getByRole('complementary', { name: 'Activity' });
        const feed = drawer.getByRole('list', { name: 'Recent activity' });
        await expect(drawer.getByText('Live: webhooks appear here')).toBeVisible();

        await raise(crm, ada, 'See you Thursday.');

        const item = itemsAbout(feed, ada).filter({ hasText: kind.title });
        await expect(item.first()).toContainText(kind.event);
        if (crm.fake) await expect(item).toContainText(ada.main_phone);
        await expect(app.toasts).toContainText(kind.title);
        await item.first().getByRole('link', { name: kind.title }).click();
        await expect(page).toHaveURL(app.url('/contacts/' + ada.contact_id));
    });

    test('counts what arrives while the list is out of sight', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/pipeline');
        const button = page.locator('#activity-button');
        await expect(page.locator('#activity-status')).toContainText('Live: webhooks appear here');
        await expect(button).toHaveAccessibleName('Activity');

        await raise(crm, ada, 'See you Thursday.');
        // The live account also reports the contact it just created, so the
        // count there is "at least one".
        await expect(button).toHaveAccessibleName(crm.fake ? 'Activity, 1 new' : /^Activity, \d+ new$/);

        await button.click();
        await expect(page.getByRole('list', { name: 'Recent activity' })).toContainText(kindFor(crm).title);
        await expect(button).toHaveAccessibleName('Activity');
    });

    test('lists earlier webhooks after a reload without announcing them again', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        // A number no other test sends, to pick this event out of the shared
        // server's buffer; live events carry no number, so their title does.
        const from = '+15550190001';
        const marker = crm.live ? kindFor(crm).title : from;
        await app.goto('/pipeline');
        await expect(page.locator('#activity-status')).toContainText('Live: webhooks appear here');
        await crm.triggerWebhook(kindFor(crm).event, ada, { from, body: 'Earlier today.' });
        await expect(app.toasts).toContainText(marker);

        await page.reload();
        const button = page.locator('#activity-button');
        await expect(page.locator('#activity-status')).toContainText('Live: webhooks appear here');
        await expect(page.locator('#activity-list')).toContainText(marker);
        await expect(button).toHaveAccessibleName('Activity');
        await expect(app.toasts).not.toContainText(marker);
    });

    test('the drawer opens on the Pipeline page, and Esc gives focus back', async ({ page, app }) => {
        await app.goto('/pipeline');
        const button = page.getByRole('button', { name: 'Activity' });
        const drawer = page.getByRole('complementary', { name: 'Activity' });
        await expect(drawer).toBeHidden();

        await button.click();
        await expect(drawer).toBeVisible();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
        await expect(drawer.getByRole('button', { name: 'Close panel' })).toBeFocused();
        await expectAccessible(page);

        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        await expect(button).toBeFocused();

        await button.click();
        await drawer.getByRole('button', { name: 'Close panel' }).click();
        await expect(drawer).toBeHidden();
        await expect(button).toBeFocused();
    });

    test('a contact\'s Activity tab shows only its own events', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        // A contact of its own, so events other tests sent to the shared
        // server cannot show up here.
        const mary = crm.fake
            ? await crm.extraPerson({ contact_id: crypto.randomUUID(), first_name: 'Mary', last_name: 'Jackson', main_phone: '+13125550145', email: 'mary@example.com' })
            : await crm.person('grace');
        await app.goto('/contacts/' + mary.contact_id);
        await page.getByRole('tab', { name: 'Activity' }).click();
        const panel = page.getByRole('tabpanel', { name: 'Activity' });
        // The live account announces the contact it just created, so only the
        // fake starts empty.
        if (crm.fake) await expect(panel.getByText('Nothing yet for ' + mary.full_name + '.')).toBeVisible();
        await expect(page.getByText('Live: webhooks appear here')).toBeAttached();

        await raise(crm, ada, 'See you Thursday.');
        await raise(crm, mary, 'See you Friday.');

        const feed = panel.getByRole('list', { name: 'Activity for ' + mary.full_name });
        const kind = kindFor(crm);
        await expect(feed.getByRole('listitem').filter({ hasText: kind.title })).toHaveCount(1);
        if (crm.fake) {
            await expect(feed.getByRole('listitem')).toHaveCount(1);
            await expect(feed).toContainText(mary.main_phone);
            await expect(feed).not.toContainText(ada.main_phone);
        }
        await expect(itemsAbout(feed, ada)).toHaveCount(0);
        await expect(panel.getByText('Nothing yet for ' + mary.full_name + '.')).toBeHidden();
    });

    test('ignores a webhook signed with the wrong secret', async ({ page, app, appServer }) => {
        await app.goto('/contacts');
        await page.getByRole('button', { name: 'Activity' }).click();
        await expect(page.getByText('Live: webhooks appear here')).toBeVisible();

        const forgedContact = crypto.randomUUID();
        const forged = await deliverWebhook(appServer.url, 'not-the-webhook-secret', {
            event: 'contact.deleted',
            data: { contact_id: forgedContact }
        });

        expect(forged.status).toBe(401);
        await page.waitForTimeout(500);
        // The live account reports the test contacts it deletes, so look for
        // the forged event's own contact rather than for any deletion.
        await expect(page.locator('#activity-list a[href*="' + forgedContact + '"]')).toHaveCount(0);
    });
});
