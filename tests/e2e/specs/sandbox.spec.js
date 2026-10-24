import crypto from 'node:crypto';
import { test as plainTest } from '@playwright/test';
import { isTestNumber, testNumberScenario } from '../../../shared/sandbox.js';
import { expectAccessible } from '../support/a11y.js';
import {
    ADA, BUSY_LINE, GRACE, KATHERINE, NO_ANSWER, SANDBOX_BUSINESS_NUMBER, SANDBOX_REPLY_PREFIX, SHOWCASE_CONTACTS
} from '../support/data.js';
import { newLivePhone, waitForEventText } from '../support/live.js';
import { test, expect } from '../support/test.js';

// The sandbox: every Drop Cowboy account can call and text 555 test numbers
// (+1 555 XXX XXXX) for free. A call is answered by Drop Cowboy's test line,
// which picks what happens from the last four digits (0001 answers, 0004 is
// never answered, 0005 is busy); a text gets the automatic reply
// "sandbox got your message: <text>" through the normal inbound webhook.
// A team with no carrier or no funds is in sandbox mode: readiness reports
// sandbox_only, and anything but a 555 number is refused.
//
// The fake account plays the sandbox for texts (support/fake-dropcowboy.js).
// The live account is the real thing, and the live E2E team has no carrier,
// so it is in sandbox mode on its own. Calls go over SIP, which only the live
// target can place; those specs are tagged @live-only.

// The contact card has Call and Text buttons of its own, further down the
// page; these are the starter's, in the contact's header.
function appButton(page, name) {
    return page.getByRole('button', { name, exact: true }).first();
}

/** Puts the fake account in sandbox mode; the live team already is. */
function sandboxMode({ dropcowboy, target }) {
    if (target !== 'live') dropcowboy.sandboxMode();
}

/**
 * Starts recording the Dock's call events in the page, once the Dock has
 * loaded: `window.sandboxCalls` gets `{ started }` and `{ ended }` entries.
 */
async function watchCalls(page) {
    await page.waitForFunction(() => window.DropCowboy && window.DropCowboy.dock
        && typeof window.DropCowboy.dock.addCallEndedListener === 'function');
    await page.evaluate(() => {
        window.sandboxCalls = { started: [], ended: [] };
        window.DropCowboy.dock.addCallStartedListener((call) => window.sandboxCalls.started.push(call));
        window.DropCowboy.dock.addCallEndedListener((call) => window.sandboxCalls.ended.push(call));
    });
}

/** Waits for the Dock's first ended call, up to `timeoutMs`, and returns what was recorded. */
async function endedCall(page, timeoutMs) {
    await page.waitForFunction(() => window.sandboxCalls && window.sandboxCalls.ended.length > 0, null, { timeout: timeoutMs });
    return page.evaluate(() => window.sandboxCalls);
}

// No browser needed: the seed data itself. Every contact the suite can put on
// an account, fake or live, must be a unique 555 test number, so no test can
// ever ring a real phone.
plainTest.describe('Seed contact numbers', () => {
    plainTest('are unique 555 test numbers, and the named ones do what they say', () => {
        const seeds = [ADA, GRACE, KATHERINE, BUSY_LINE, NO_ANSWER].concat(SHOWCASE_CONTACTS);
        const numbers = seeds.map((contact) => contact.main_phone);
        for (const number of numbers) {
            expect(isTestNumber(number), number + ' is a 555 test number').toBe(true);
        }
        expect(new Set(numbers).size).toBe(numbers.length);
        expect(numbers).not.toContain(SANDBOX_BUSINESS_NUMBER);
        for (const contact of [ADA, GRACE, KATHERINE].concat(SHOWCASE_CONTACTS)) {
            expect(testNumberScenario(contact.main_phone)).toMatch(/^answers/);
        }
        expect(testNumberScenario(BUSY_LINE.main_phone)).toBe('is busy');
        expect(testNumberScenario(NO_ANSWER.main_phone)).toBe('rings and is never answered');
    });

    plainTest('the live suite makes a fresh test number for each scenario', () => {
        const made = ['answer', 'answer', 'busy', 'no_answer'].map((scenario) => newLivePhone(scenario));
        for (const number of made) expect(isTestNumber(number)).toBe(true);
        expect(new Set(made).size).toBe(made.length);
        expect(testNumberScenario(made[2])).toBe('is busy');
        expect(testNumberScenario(made[3])).toBe('rings and is never answered');
        expect(() => newLivePhone('ring_forever')).toThrow();
    });
});

test.describe('Sandbox mode', () => {
    test.beforeEach(sandboxMode);

    test('Setup explains the test numbers, and that the session reaches only them', async ({ page, app }) => {
        await app.goto('/setup');

        const notice = page.locator('.notice.info').filter({ hasText: 'Sandbox: test numbers only' });
        await expect(notice).toBeVisible();
        await expect(notice).toContainText('555 test numbers (+1 555 XXX XXXX)');
        await expect(notice).toContainText('never ring a real phone');
        await expect(page.getByText('Session token: ready for test numbers')).toBeVisible();
        await expect(page.getByText('Session token: ready', { exact: true })).toHaveCount(0);
        await expectAccessible(page);
    });

    test('a contact with a test number says what a call to it does', async ({ page, app, crm }) => {
        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);

        const hint = page.locator('#sandbox-hint');
        await expect(hint).toContainText('is a test number: a call answers');
        await expect(hint).toContainText('never reaches a real phone');
        await expect(appButton(page, 'Call')).toHaveAttribute('aria-describedby', 'sandbox-hint');
        await expectAccessible(page);
    });

    test('the busy test contact says it is busy', async ({ page, app, crm }) => {
        const busy = await crm.person('busy');
        await app.goto('/contacts/' + busy.contact_id);

        await expect(page.locator('#sandbox-hint')).toContainText('a call is busy');
    });

    // @fake-only: the contact has a real-format number, which the live
    // suite never puts on an account.
    test('a contact with a real number says calls and texts to it are refused @fake-only', async ({ page, app, crm }) => {
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

        await expect(page.locator('#sandbox-hint')).toContainText('555 test numbers only');
        await expect(page.locator('#sandbox-hint')).toContainText('refused until a carrier is connected');
    });

    test('a text to a test number gets the sandbox\'s automatic reply through the webhook', async ({ page, app, crm, appServer, target, live, dropcowboy }) => {
        // On live the reply arrives as a real webhook, so it needs the tunnel.
        test.skip(target === 'live' && !(live && live.webhookId), 'needs the webhook tunnel (DROPCOWBOY live webhook registration)');
        test.setTimeout(target === 'live' ? 150000 : 30000);
        const ada = await crm.person('ada');
        await crm.recordConsent(ada);
        const marker = 'Sandbox check ' + crypto.randomUUID();
        await app.useBusinessNumber(SANDBOX_BUSINESS_NUMBER);
        await app.goto('/contacts/' + ada.contact_id);

        await appButton(page, 'Text').click();
        const dock = page.locator('dc-dock');
        await dock.getByRole('textbox', { name: 'Message' }).fill(marker);
        await dock.getByRole('button', { name: 'Send' }).click();

        const arrived = await waitForEventText(appServer.url, ['contact.msg.received', SANDBOX_REPLY_PREFIX + marker], {
            timeoutMs: target === 'live' ? 120000 : 15000
        });
        expect(arrived, 'the sandbox reply reached the server as a contact.msg.received webhook').toBe(true);
        await expect(app.toasts).toContainText('Text received');
        if (crm.fake) {
            expect(dropcowboy.texts).toEqual([
                expect.objectContaining({ contact_id: ada.contact_id, to: ada.main_phone, body: marker })
            ]);
            expect(dropcowboy.sandboxReplies.map((reply) => reply.sms_body)).toEqual([SANDBOX_REPLY_PREFIX + marker]);
        }
    });

    // @fake-only: the live suite never sends to a number that could be real.
    test('a text to a real number is refused with sandbox_only, and the page says why @fake-only', async ({ page, app, crm, dropcowboy }) => {
        const uk = await crm.extraPerson({
            contact_id: crypto.randomUUID(),
            first_name: 'Rosalind',
            last_name: 'Franklin',
            main_phone: '+447700900123',
            email: 'rosalind@example.com',
            has_sms_consent: true,
            created_at: 1791301200000
        });
        await app.useBusinessNumber(SANDBOX_BUSINESS_NUMBER);
        await app.goto('/contacts/' + uk.contact_id);

        await appButton(page, 'Text').click();
        const dock = page.locator('dc-dock');
        await dock.getByRole('textbox', { name: 'Message' }).fill('Hello from the sandbox');
        await dock.getByRole('button', { name: 'Send' }).click();

        await expect.poll(() => dropcowboy.callsTo('POST', '/phone/embed/sms').length).toBe(1);
        const [send] = dropcowboy.callsTo('POST', '/phone/embed/sms');
        expect(send.status).toBe(403);
        await expect(app.toasts).toContainText('Test numbers only');
        expect(dropcowboy.sandboxReplies).toEqual([]);
    });

    // @fake-only: checks the request the Dock sent, which only the fake records.
    test('texts a test number with no business number, and the inbox does not ask for one @fake-only', async ({ page, app, crm, dropcowboy }) => {
        const ada = await crm.person('ada');
        await crm.recordConsent(ada);
        await app.goto('/contacts/' + ada.contact_id);

        await appButton(page, 'Text').click();
        const dock = page.locator('dc-dock');
        await dock.getByRole('textbox', { name: 'Message' }).fill('First text, no number of my own');
        await dock.getByRole('button', { name: 'Send' }).click();

        await expect.poll(() => dropcowboy.texts.length).toBe(1);
        expect(dropcowboy.texts[0]).toEqual(expect.objectContaining({ to: ada.main_phone, from: null }));
        await expect(app.toasts).not.toContainText('Set a business number');

        await app.goto('/inbox');
        await expect(page.locator('dc-shared-inbox')).toBeVisible();
        await expect(page.getByRole('main')).not.toContainText('Set a business number');
    });
});

test.describe('Without sandbox mode', () => {
    // @fake-only: the live team's mode is whatever its account is.
    test('Setup shows no sandbox notice, and the contact no test-number hint @fake-only', async ({ page, app, crm }) => {
        await app.goto('/setup');
        await expect(page.getByText('Session token: ready', { exact: true })).toBeVisible();
        await expect(page.getByText('Sandbox: test numbers only')).toHaveCount(0);

        const ada = await crm.person('ada');
        await app.goto('/contacts/' + ada.contact_id);
        await expect(page.getByRole('heading', { name: ada.full_name, level: 1 })).toBeVisible();
        await expect(page.locator('#sandbox-hint')).toBeHidden();
        await expect(appButton(page, 'Call')).not.toHaveAttribute('aria-describedby', 'sandbox-hint');
    });
});

// Real calls to the test line. They need a calling token and a microphone,
// so they run only against the live account (npm run test:live), where
// Chrome is started with a fake microphone (playwright.config.js).
test.describe('Calling test numbers', () => {
    test.use({ permissions: ['microphone'] });

    test('a call to a test number that answers connects and ends normally @live-only', async ({ page, app, crm }) => {
        test.setTimeout(150000);
        const ada = await crm.person('ada');
        await crm.recordConsent(ada);
        await app.goto('/contacts/' + ada.contact_id);
        await watchCalls(page);

        await appButton(page, 'Call').click();

        // The 0001 line answers and hangs up after about 30 seconds.
        const calls = await endedCall(page, 120000);
        expect(calls.started.length, 'the Dock started the call').toBeGreaterThan(0);
        const [ended] = calls.ended;
        expect(ended.number).toBe(ada.main_phone);
        expect(ended.disposition, 'the test line hung up after talking').toBe('completed');
        expect(ended.duration_ms, 'the call lasted until the test line hung up').toBeGreaterThanOrEqual(25000);
    });

    test('a call to the busy test number ends without connecting @live-only', async ({ page, app, crm }) => {
        test.setTimeout(150000);
        const busy = await crm.person('busy');
        await crm.recordConsent(busy);
        await app.goto('/contacts/' + busy.contact_id);
        await watchCalls(page);

        await appButton(page, 'Call').click();

        const calls = await endedCall(page, 60000);
        const [ended] = calls.ended;
        expect(ended.number).toBe(busy.main_phone);
        expect(ended.disposition).toBe('busy');
        expect(ended.duration_ms, 'nobody picked up').toBe(0);
    });
});
