import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainError } from '../errors.js';
import {
    contactSandboxHint,
    isSandboxOnly,
    isTestNumber,
    sandboxNotice,
    sessionReadyNotice,
    testNumberScenario
} from '../sandbox.js';

describe('sandbox test numbers', () => {
    it('knows a 555 test number in any common format, and nothing else', () => {
        assert.equal(isTestNumber('+15550100001'), true);
        assert.equal(isTestNumber('(555) 010-0001'), true);
        assert.equal(isTestNumber('1 555 010 0001'), true);
        // A real area code with a 555 exchange is a real number.
        assert.equal(isTestNumber('+13125550142'), false);
        assert.equal(isTestNumber('+447700900123'), false);
        assert.equal(isTestNumber(''), false);
        assert.equal(isTestNumber(null), false);
    });

    it('reads the scenario from the last four digits; anything unlisted answers', () => {
        assert.equal(testNumberScenario('+15550100001'), 'answers, then hangs up after about 30 seconds');
        assert.equal(testNumberScenario('+15550100004'), 'rings and is never answered');
        assert.equal(testNumberScenario('+15550100005'), 'is busy');
        assert.equal(testNumberScenario('+15550104242'), testNumberScenario('+15550100001'));
        assert.equal(testNumberScenario('+13125550142'), null);
    });
});

describe('sandbox mode notices', () => {
    it('counts sandbox_only only when readiness says exactly true', () => {
        assert.equal(isSandboxOnly({ sandbox_only: true }), true);
        assert.equal(isSandboxOnly({ sandbox_only: 'true' }), false);
        assert.equal(isSandboxOnly({}), false);
        assert.equal(isSandboxOnly(null), false);
    });

    it('explains the sandbox on Setup without promising real calls', () => {
        const notice = sandboxNotice({ sandbox_only: true });
        assert.equal(notice.title, 'Sandbox: test numbers only');
        assert.match(notice.message, /555 test numbers \(\+1 555 XXX XXXX\)/);
        assert.match(notice.message, /never ring a real phone/);
        assert.match(notice.message, /sandbox got your message/);
        assert.equal(sandboxNotice({ sandbox_only: false }), null);
        assert.equal(sandboxNotice(null), null);
    });

    it('words the session status for sandbox mode, and keeps the old wording otherwise', () => {
        assert.equal(sessionReadyNotice({ sandbox_only: true }).title, 'Session token: ready for test numbers');
        assert.match(sessionReadyNotice({ sandbox_only: true }).message, /Real numbers need a carrier/);
        assert.equal(sessionReadyNotice(null).title, 'Session token: ready');
        assert.equal(sessionReadyNotice({}).message, 'Calling, texting and the inbox in the Dock are available.');
    });

    it('hints on a contact only in sandbox mode, by what its number will do', () => {
        assert.equal(contactSandboxHint(false, '+15550100001'), null);
        assert.equal(contactSandboxHint(true, ''), null);
        assert.equal(
            contactSandboxHint(true, '+15550100005'),
            '(555) 010-0005 is a test number: a call is busy, and a text gets an automatic reply. It never reaches a real phone.'
        );
        assert.match(contactSandboxHint(true, '+447700900123'), /555 test numbers only, so a call or text to this number is refused/);
    });

    it('explains the sandbox refusals', () => {
        assert.equal(explainError({ code: 'sandbox_only' }).title, 'Test numbers only');
        assert.match(explainError({ code: 'sandbox_only' }).message, /connect a carrier to reach real phones/);
        assert.equal(explainError({ code: 'sandbox_concurrency' }).title, 'Too many test calls at once');
        assert.equal(explainError({ code: 'sandbox_caller_id' }).title, 'A 555 caller ID calls only 555 numbers');
    });
});
