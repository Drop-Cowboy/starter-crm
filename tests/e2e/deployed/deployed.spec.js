import crypto from 'node:crypto';
import { test as base, expect } from '@playwright/test';

// The deployed CRM in a real browser: sign in with the passcode, see the app
// shell, and watch a signed event arrive in the activity feed. It needs the
// passcode and a webhook secret the host accepts. Without them every test is
// skipped, unless STARTER_CRM_DEPLOYED_REQUIRE_ALL=1.
//
// Where it sits: run by scripts/test-deployed.mjs through deployed.config.js,
// once per front-end (the vanilla app at / and the React build at /react/).
// It sends one fictional event about a made-up contact (a 555 test number)
// and nothing else: it never calls Drop Cowboy, and nothing is sent to a phone.

const PASSCODE = process.env.STARTER_CRM_DEPLOYED_PASSCODE || '';
const WEBHOOK_SECRET = process.env.STARTER_CRM_DEPLOYED_WEBHOOK_SECRET || '';
const REQUIRE_ALL = process.env.STARTER_CRM_DEPLOYED_REQUIRE_ALL === '1';

const test = base.extend({
    entry: ['/', { option: true }]
});

test.beforeEach(({}, testInfo) => {
    const ready = Boolean(PASSCODE && WEBHOOK_SECRET);
    if (!ready && REQUIRE_ALL) throw new Error('The passcode and the webhook secret are required (STARTER_CRM_DEPLOYED_REQUIRE_ALL=1)');
    testInfo.skip(!ready, 'the passcode or the webhook secret was not given');
});

/** Posts one signed fictional event, as Drop Cowboy would. */
async function deliver(request, marker) {
    const eventId = crypto.randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
        event_id: eventId,
        event: 'contact.msg.received',
        event_at: new Date().toISOString(),
        data: { contact_id: crypto.randomUUID(), from: '+15550110001', body: marker }
    });
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(timestamp + '.' + body).digest('hex');
    return request.post('/webhooks/dropcowboy', {
        headers: {
            'content-type': 'application/json',
            'x-signature': 'sha256=' + signature,
            'x-signature-version': 'v1',
            'x-timestamp': timestamp,
            'x-event-id': eventId,
            'x-attempt': '1'
        },
        data: body
    });
}

test.describe('deployed host', () => {
    test('signs in, shows the app, and lists a signed webhook in the activity feed', async ({ page, request, context, entry }) => {
        const problems = [];
        page.on('pageerror', (err) => problems.push('page error: ' + err.message));
        page.on('requestfailed', (req) => problems.push('request failed: ' + new URL(req.url()).origin + ' ' + (req.failure() || {}).errorText));

        await page.goto(entry + (entry.endsWith('/') ? '' : '/') + 'contacts');
        await expect(page.getByRole('heading', { name: 'Sign in to Starter CRM', level: 1 })).toBeVisible();

        // One sign-in only: the route allows 10 a minute per address, and a wrong
        // passcode is the conformance suite's job, not a host's.
        await page.getByLabel('Passcode').fill(PASSCODE);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

        // The browser holds a session cookie it cannot read, never the passcode.
        const [cookie] = (await context.cookies()).filter((item) => /^(__Host-)?starter_crm_session$/.test(item.name));
        expect(cookie.httpOnly).toBe(true);
        expect(cookie.value).not.toContain(PASSCODE);
        expect(await page.evaluate(() => document.cookie)).toBe('');
        if (new URL(page.url()).protocol === 'https:') expect(cookie.secure).toBe(true);

        await page.getByRole('button', { name: 'Activity' }).click();
        const drawer = page.getByRole('complementary', { name: 'Activity' });
        await expect(drawer.getByText('Live: webhooks appear here')).toBeVisible();

        const marker = 'deployed-ui-' + crypto.randomUUID().slice(0, 8);
        const delivered = await deliver(request, marker);
        expect(delivered.status()).toBe(200);
        await expect(drawer.getByRole('list', { name: 'Recent activity' })).toContainText('Text received');

        await page.reload();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('heading', { name: 'Sign in to Starter CRM', level: 1 })).toBeVisible();

        expect(problems, 'the page reported problems').toEqual([]);
    });
});
