import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../errors.js';
import { contactWidgets, sessionWidgets, textContact } from '../widgets.js';

function fakeCrm() {
    const contactsManager = { name: 'contacts' };
    const sessionManager = { name: 'session' };
    const crm = {
        loaded: [],
        dockStarts: 0,
        cdn: {
            loadElements: async (tags) => {
                crm.loaded.push(...tags);
            }
        },
        startContacts: async () => ({ getTokenManager: () => contactsManager }),
        startDock: async () => {
            crm.dockStarts += 1;
            return { getTokenManager: () => sessionManager };
        }
    };
    return crm;
}

describe('widget token managers', () => {
    it('gives contact widgets the contacts token manager without starting the Dock', async () => {
        const crm = fakeCrm();
        const { tokenManager } = await contactWidgets(crm, ['dc-contact-card']);
        assert.equal(tokenManager.name, 'contacts');
        assert.deepEqual(crm.loaded, ['dc-contact-card']);
        assert.equal(crm.dockStarts, 0);
    });

    it('still connects contact widgets when the session mint fails with byoc_required', async () => {
        const crm = fakeCrm();
        crm.startDock = async () => {
            throw new AppError('byoc_required', 'Connect a carrier.', { status: 403 });
        };
        await assert.rejects(sessionWidgets(crm, ['dc-shared-inbox']), { code: 'byoc_required' });
        const { tokenManager } = await contactWidgets(crm, ['dc-pipeline-board']);
        assert.equal(tokenManager.name, 'contacts');
    });

    it('gives the inbox the Dock\'s session token manager', async () => {
        const crm = fakeCrm();
        const { tokenManager } = await sessionWidgets(crm, ['dc-shared-inbox']);
        assert.equal(tokenManager.name, 'session');
        assert.equal(crm.dockStarts, 1);
    });
});

describe('textContact', () => {
    // getBusinessNumber() reads localStorage, which Node does not have.
    function withBusinessNumber(number, run) {
        const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        const items = new Map(number ? [['starter-crm.business-number', number]] : []);
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: { getItem: (key) => (items.has(key) ? items.get(key) : null), setItem: (key, value) => items.set(key, value), removeItem: (key) => items.delete(key) }
        });
        return run().finally(() => {
            if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
            else delete globalThis.localStorage;
        });
    }

    function dockCrm() {
        const crm = fakeCrm();
        crm.texted = [];
        crm.startDock = async () => ({ text: async (target) => crm.texted.push(target) });
        return crm;
    }

    it('asks for a business number before texting a real number', () => withBusinessNumber('', async () => {
        const crm = dockCrm();
        const contact = { id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', main_phone: '+13125550142' };
        await assert.rejects(textContact(crm, contact), { code: 'business_number_missing' });
        assert.deepEqual(crm.texted, []);
    }));

    it('texts a 555 test number without one, since Drop Cowboy picks a 555 sender', () => withBusinessNumber('', async () => {
        const crm = dockCrm();
        const contact = { id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', main_phone: '+15555550002' };
        await textContact(crm, contact);
        assert.deepEqual(crm.texted, [{ contact_id: contact.id, phone: '+15555550002' }]);
    }));

    it('texts a real number once a business number is saved', () => withBusinessNumber('+13125550100', async () => {
        const crm = dockCrm();
        const contact = { id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', main_phone: '+13125550142' };
        await textContact(crm, contact);
        assert.equal(crm.texted.length, 1);
    }));
});
