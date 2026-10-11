import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contactName, formatPhone, isEmail, toE164 } from '../format.js';
import { getBusinessNumber, setBusinessNumber } from '../settings.js';
import { isReady, itemStatus, setupChecklist } from '../setup.js';
import { memoryStorage } from './helpers.js';

describe('format', () => {
    it('turns common US formats into E.164 and rejects text', () => {
        assert.equal(toE164('(312) 555-0142'), '+13125550142');
        assert.equal(toE164('1 312 555 0142'), '+13125550142');
        assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
        assert.equal(toE164('Dana'), '');
        assert.equal(toE164('5550142'), '');
    });

    it('names a contact by name, then email, then phone', () => {
        assert.equal(contactName({ first_name: 'Dana', last_name: 'Reyes' }), 'Dana Reyes');
        assert.equal(contactName({ email: 'dana@example.com' }), 'dana@example.com');
        assert.equal(contactName({ main_phone: '+13125550142' }), '(312) 555-0142');
        assert.equal(contactName({}), 'Unnamed contact');
        assert.equal(formatPhone('+442079460958'), '+442079460958');
        assert.equal(isEmail('a@example.com'), true);
    });
});

describe('settings', () => {
    it('stores the business number as E.164 and nothing else', () => {
        const storage = memoryStorage();
        assert.equal(setBusinessNumber('312-555-0100', storage), '+13125550100');
        assert.equal(getBusinessNumber(storage), '+13125550100');
        assert.deepEqual(storage.keys(), ['starter-crm.business-number']);
        assert.equal(setBusinessNumber('nope', storage), '');
        assert.deepEqual(storage.keys(), []);
    });
});

describe('setup checklist', () => {
    const READINESS = {
        embed_ready: false,
        next_actions: ['connect_byoc'],
        building_blocks_enabled: true,
        byoc: { connected: false, providers: [] },
        funds: { available: 10, funds_ok: true },
        numbers: { count: 1 },
        embed_resolve_contact_consent: false
    };

    it('marks each item from readiness', () => {
        const items = setupChecklist(READINESS, { siteId: 'x', businessNumber: '+13125550100' });
        const byId = Object.fromEntries(items.map((i) => [i.id, i]));
        assert.equal(byId.enable_building_blocks.done, true);
        assert.equal(byId.connect_byoc.done, false);
        assert.equal(byId.e911_location.done, null);
        assert.equal(byId.contact_consent.optional, true);
        assert.equal(byId.phone_number.done, true);
        assert.equal(byId.texting_line.done, null);
        assert.equal(isReady(items), false);
    });

    it('labels an optional setting that is off as optional, not as a to-do', () => {
        const items = setupChecklist(READINESS, { siteId: 'x', businessNumber: '+13125550100' });
        const byId = Object.fromEntries(items.map((i) => [i.id, i]));
        assert.deepEqual(itemStatus(byId.contact_consent), { label: 'Optional', className: 'unknown' });
        assert.deepEqual(itemStatus({ done: true, optional: true }), { label: 'On', className: 'done' });
        assert.deepEqual(itemStatus(byId.connect_byoc), { label: 'To do', className: 'todo' });
        assert.deepEqual(itemStatus(byId.funds), { label: 'Done', className: 'done' });
        assert.deepEqual(itemStatus(byId.e911_location), { label: 'Check', className: 'unknown' });
    });

    it('checks nothing it cannot see in mcp-session mode', () => {
        const items = setupChecklist(null, { siteId: null, businessNumber: '+13125550100' });
        assert.equal(items.find((i) => i.id === 'connect_byoc').done, null);
        assert.equal(isReady(items), true);
    });
});
