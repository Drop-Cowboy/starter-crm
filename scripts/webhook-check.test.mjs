import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeRegistration, looksSwitchedOff, webhooksOf } from './lib/webhook-check.mjs';

const URL = 'https://crm.example.com';
const HOOK = { webhook_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', hook_url: 'https://crm.example.com/webhooks/dropcowboy' };

describe('webhooksOf', () => {
    it('reads an array, a data envelope, and shrugs at anything else', () => {
        assert.deepEqual(webhooksOf([HOOK]), [HOOK]);
        assert.deepEqual(webhooksOf({ data: [HOOK] }), [HOOK]);
        assert.deepEqual(webhooksOf({ error: 'x' }), []);
        assert.deepEqual(webhooksOf(null), []);
    });
});

describe('looksSwitchedOff', () => {
    it('reads the fields a disabled flag would use', () => {
        assert.equal(looksSwitchedOff({ disabled: true }), true);
        assert.equal(looksSwitchedOff({ enabled: false }), true);
        assert.equal(looksSwitchedOff({ is_active: false }), true);
        assert.equal(looksSwitchedOff({ status: 'Paused' }), true);
        assert.equal(looksSwitchedOff({ status: 'active' }), false);
        assert.equal(looksSwitchedOff({}), false);
    });
});

describe('judgeRegistration', () => {
    it('is unknown without DC_PUBLIC_URL', () => {
        assert.equal(judgeRegistration([HOOK], '').state, 'unknown');
    });

    it('finds the webhook whatever the trailing slash', () => {
        assert.equal(judgeRegistration([HOOK], URL + '/').state, 'ok');
    });

    it('reports a missing webhook', () => {
        const verdict = judgeRegistration([{ hook_url: 'https://other.example.com/hook' }], URL);
        assert.equal(verdict.state, 'missing');
        assert.match(verdict.message, /crm\.example\.com\/webhooks\/dropcowboy/);
    });

    it('reports a switched-off webhook, and not one that has a live twin', () => {
        assert.equal(judgeRegistration([{ ...HOOK, disabled: true }], URL).state, 'switched_off');
        assert.equal(judgeRegistration([{ ...HOOK, disabled: true }, HOOK], URL).state, 'ok');
    });
});
