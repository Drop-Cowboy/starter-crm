import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../errors.js';
import { contactWidgets, sessionWidgets } from '../widgets.js';

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
