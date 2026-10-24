// Test numbers and sandbox mode. No dependencies beyond format.js, no DOM.
//
// Every Drop Cowboy account has a sandbox: the 555 area code,
// +1 555 XXX XXXX. No real phone has a 555 area code, so Drop Cowboy keeps
// those numbers for testing. A call to one is answered by Drop Cowboy's test
// line, which picks what happens from the last four digits (see
// TEST_NUMBER_SCENARIOS). A text to one gets an automatic reply,
// "sandbox got your message: <your text>", delivered through your inbound
// webhook like any other reply. Test calls and texts are free, and they never
// reach a real phone.
//
// A team that has no carrier connected, or no funds, can still use the
// sandbox. Its session token then carries a sandbox_only claim: calls and
// texts to 555 numbers work, and anything else is refused with
// detail.code "sandbox_only". The readiness check says so with
// `sandbox_only: true`, and this file turns that into the short notices the
// Setup and contact pages show. Readiness from an account or a server that
// does not know about the sandbox has no sandbox_only field; then nothing
// here shows, and the pages behave as they always did.

import { formatPhone, toE164 } from './format.js';

/**
 * What the test line does for each last four digits. Any other last four
 * answers like 0001. The words complete "A call to this number ...".
 * @type {Readonly<Record<string, string>>}
 */
export const TEST_NUMBER_SCENARIOS = Object.freeze({
    '0001': 'answers, then hangs up after about 30 seconds',
    '0002': 'answers with a person speaking',
    '0003': 'goes to voicemail',
    '0004': 'rings and is never answered',
    '0005': 'is busy',
    '0006': 'fails, as an unreachable network would',
    '0007': 'is rejected',
    '0008': 'answers and presses 1 to confirm',
    '0009': 'answers and presses 9 to opt out',
    '0010': 'answers and presses 0 to ask for a person'
});

/** What a test number with any other last four does. */
const DEFAULT_SCENARIO = TEST_NUMBER_SCENARIOS['0001'];

/**
 * Is this a sandbox test number (+1 555 XXX XXXX)? Accepts the number typed
 * any common way, the same as toE164().
 * @param {unknown} value A phone number, in E.164 or as a person types it.
 * @returns {boolean} True for a number in the 555 area code.
 */
export function isTestNumber(value) {
    return /^\+1555\d{7}$/.test(toE164(value));
}

/**
 * What a call to a test number does, chosen by its last four digits.
 * @param {unknown} value A phone number, in E.164 or as a person types it.
 * @returns {string | null} Words that complete "A call to this number ...",
 *   or null when the number is not a test number.
 */
export function testNumberScenario(value) {
    if (!isTestNumber(value)) {
        return null;
    }
    return TEST_NUMBER_SCENARIOS[toE164(value).slice(-4)] || DEFAULT_SCENARIO;
}

/**
 * Does readiness say this team can reach test numbers only? Only an explicit
 * `true` counts, so readiness without the field keeps the old behaviour.
 * @param {object | null | undefined} readiness From crm.readiness(), or null.
 * @returns {boolean} True when the session token is limited to 555 numbers.
 */
export function isSandboxOnly(readiness) {
    return Boolean(readiness) && readiness.sandbox_only === true;
}

/**
 * The Setup page's sandbox notice, or null when readiness does not report
 * sandbox_only. Informational, not an error: the team is set up correctly
 * for testing, it just cannot reach real phones yet.
 * @param {object | null | undefined} readiness From crm.readiness(), or null.
 * @returns {{ title: string, message: string } | null} The notice to show.
 */
export function sandboxNotice(readiness) {
    if (!isSandboxOnly(readiness)) {
        return null;
    }
    return {
        title: 'Sandbox: test numbers only',
        message: 'Until a carrier is connected and funded, calls and texts from this app reach only 555 test numbers '
            + '(+1 555 XXX XXXX). They are free and never ring a real phone. A call\'s last four digits pick what '
            + 'happens: 0001 answers, 0004 is never answered, 0005 is busy. A text gets an automatic reply, '
            + '"sandbox got your message: …". Any other number is refused (sandbox_only).'
    };
}

/**
 * The Setup page's "session token: ready" notice. In sandbox mode it says
 * which numbers the Dock can reach instead of promising real calls.
 * @param {object | null | undefined} readiness From crm.readiness(), or null.
 * @returns {{ title: string, message: string }} The notice to show.
 */
export function sessionReadyNotice(readiness) {
    if (isSandboxOnly(readiness)) {
        return {
            title: 'Session token: ready for test numbers',
            message: 'The Dock can call and text 555 test numbers, and the inbox works as usual. Real numbers need a carrier.'
        };
    }
    return { title: 'Session token: ready', message: 'Calling, texting and the inbox in the Dock are available.' };
}

/**
 * The hint under a contact's Call and Text buttons in sandbox mode, or null
 * outside sandbox mode or when the contact has no phone.
 * @param {boolean} sandboxOnly From crm.sandboxOnly().
 * @param {unknown} phone The contact's main phone.
 * @returns {string | null} One sentence about what Call and Text will do.
 */
export function contactSandboxHint(sandboxOnly, phone) {
    if (sandboxOnly !== true || !phone) {
        return null;
    }
    const scenario = testNumberScenario(phone);
    if (scenario) {
        return formatPhone(toE164(phone)) + ' is a test number: a call ' + scenario
            + ', and a text gets an automatic reply. It never reaches a real phone.';
    }
    return 'This team can reach 555 test numbers only, so a call or text to this number is refused until a carrier is connected.';
}
