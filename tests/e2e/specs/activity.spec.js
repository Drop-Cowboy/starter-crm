import { expectAccessible } from '../support/a11y.js';
import { ADA } from '../support/data.js';
import { test, expect } from '../support/test.js';
import { deliverWebhook } from '../support/webhook.js';

// Drop Cowboy POSTs signed webhooks to the server; the server checks the
// signature and pushes each event to open pages over Server-Sent Events.
// On pages without the context rail, the Activity button opens them in a
// drawer.

function textReceived() {
    return {
        event: 'contact.msg.received',
        data: { contact_id: ADA.contact_id, from: ADA.main_phone, body: 'See you Thursday.' }
    };
}

test.describe('Activity', () => {
    test('shows a signed webhook as it arrives', async ({ page, app, appServer, secrets }) => {
        await app.goto('/contacts');
        await page.getByRole('button', { name: 'Activity' }).click();
        const drawer = page.getByRole('complementary', { name: 'Activity' });
        const feed = drawer.getByRole('list', { name: 'Recent activity' });
        await expect(drawer.getByText('Live: webhooks appear here')).toBeVisible();

        const delivery = await deliverWebhook(appServer.url, secrets.webhookSecret, textReceived());
        expect(delivery.status).toBe(200);

        const item = feed.getByRole('listitem').filter({ hasText: 'Text received' });
        await expect(item).toContainText(ADA.main_phone);
        await expect(item).toContainText('contact.msg.received');
        await expect(app.toasts).toContainText('Text received');
        await item.getByRole('link', { name: 'Text received' }).click();
        await expect(page).toHaveURL(app.url('/contacts/' + ADA.contact_id));
    });

    test('counts what arrives while the list is out of sight', async ({ page, app, appServer, secrets }) => {
        await app.goto('/pipeline');
        const button = page.locator('#activity-button');
        await expect(page.locator('#activity-status')).toContainText('Live: webhooks appear here');
        await expect(button).toHaveAccessibleName('Activity');

        await deliverWebhook(appServer.url, secrets.webhookSecret, textReceived());
        await expect(button).toHaveAccessibleName('Activity, 1 new');

        await button.click();
        await expect(page.getByRole('list', { name: 'Recent activity' })).toContainText('Text received');
        await expect(button).toHaveAccessibleName('Activity');
    });

    test('lists earlier webhooks after a reload without announcing them again', async ({ page, app, appServer, secrets }) => {
        // A number no other test sends, to pick this event out of the shared server's buffer.
        const from = '+13125550146';
        await app.goto('/pipeline');
        await expect(page.locator('#activity-status')).toContainText('Live: webhooks appear here');
        await deliverWebhook(appServer.url, secrets.webhookSecret, {
            event: 'contact.msg.received',
            data: { contact_id: ADA.contact_id, from, body: 'Earlier today.' }
        });
        await expect(app.toasts).toContainText(from);

        await page.reload();
        const button = page.locator('#activity-button');
        await expect(page.locator('#activity-status')).toContainText('Live: webhooks appear here');
        await expect(page.locator('#activity-list')).toContainText(from);
        await expect(button).toHaveAccessibleName('Activity');
        await expect(app.toasts).not.toContainText(from);
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

    test('a contact\'s Activity tab shows only its own events', async ({ page, app, dropcowboy, appServer, secrets }) => {
        // A contact of its own, so events other tests sent to the shared
        // server cannot show up here.
        const mary = { contact_id: crypto.randomUUID(), first_name: 'Mary', last_name: 'Jackson', main_phone: '+13125550145', email: 'mary@example.com' };
        dropcowboy.contacts.set(mary.contact_id, mary);
        await app.goto('/contacts/' + mary.contact_id);
        await page.getByRole('tab', { name: 'Activity' }).click();
        const panel = page.getByRole('tabpanel', { name: 'Activity' });
        await expect(panel.getByText('Nothing yet for Mary Jackson.')).toBeVisible();
        await expect(page.getByText('Live: webhooks appear here')).toBeAttached();

        await deliverWebhook(appServer.url, secrets.webhookSecret, textReceived());
        await deliverWebhook(appServer.url, secrets.webhookSecret, {
            event: 'contact.msg.received',
            data: { contact_id: mary.contact_id, from: mary.main_phone, body: 'See you Friday.' }
        });

        const feed = panel.getByRole('list', { name: 'Activity for Mary Jackson' });
        await expect(feed.getByRole('listitem')).toHaveCount(1);
        await expect(feed).toContainText(mary.main_phone);
        await expect(feed).not.toContainText(ADA.main_phone);
        await expect(panel.getByText('Nothing yet for Mary Jackson.')).toBeHidden();
    });

    test('ignores a webhook signed with the wrong secret', async ({ page, app, appServer }) => {
        await app.goto('/contacts');
        await page.getByRole('button', { name: 'Activity' }).click();
        await expect(page.getByText('Live: webhooks appear here')).toBeVisible();

        const forged = await deliverWebhook(appServer.url, 'not-the-webhook-secret', {
            event: 'contact.deleted',
            data: { contact_id: ADA.contact_id }
        });

        expect(forged.status).toBe(401);
        await page.waitForTimeout(500);
        await expect(page.getByRole('list', { name: 'Recent activity' }).getByText('Contact deleted')).toHaveCount(0);
    });
});
