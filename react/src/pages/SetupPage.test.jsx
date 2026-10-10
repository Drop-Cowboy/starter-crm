import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeCrm, renderPage } from '../test/render.jsx';
import { SetupPage } from './SetupPage.jsx';

const READY_EXCEPT_BYOC = {
    embed_ready: false,
    next_actions: ['connect_byoc'],
    building_blocks_enabled: true,
    byoc: { connected: false, providers: [] },
    funds: { available: 2500, funds_ok: true },
    numbers: { count: 1 },
    embed_resolve_contact_consent: false
};

afterEach(() => {
    cleanup();
    localStorage.clear();
});

function statusOf(itemTitle) {
    const item = screen.getByText(itemTitle).closest('li');
    return within(item).getByText(/^(Done|To do|Check|On|Optional)$/).textContent;
}

describe('SetupPage', () => {
    it('marks each checklist item from the readiness report', async () => {
        const crm = fakeCrm({ readiness: () => Promise.resolve(READY_EXCEPT_BYOC) });
        renderPage(<SetupPage />, { crm });

        expect(await screen.findByText('Work through the items marked "To do", then reload this page.')).toBeTruthy();
        expect(statusOf('Turn on Building Blocks')).toBe('Done');
        expect(statusOf('Connect your carrier (BYOC)')).toBe('To do');
        expect(statusOf('E911 location for calling')).toBe('Check');
        expect(statusOf('A phone number')).toBe('Done');
        expect(statusOf('Texting registration (10DLC)')).toBe('Check');
        expect(statusOf('Use existing contact consent (optional)')).toBe('Optional');
        expect(await screen.findByText('Session token: ready')).toBeTruthy();
    });

    it('asks for sign-in setup when login mode has no client id', async () => {
        const crm = fakeCrm({
            config: { auth_mode: 'login', site_id: null },
            login: { isConfigured: () => false, isSignedIn: () => false, signIn: () => {} },
            needsSignIn: () => true
        });
        renderPage(<SetupPage />, { crm });

        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Sign in with Drop Cowboy' })).toBeNull();
        expect(await screen.findByText('Your account could not be checked right now, so nothing is marked.')).toBeTruthy();
    });

    it('says mcp-session mode cannot check the account', async () => {
        const crm = fakeCrm({
            config: { auth_mode: 'mcp-session', site_id: null },
            tokens: { supports: (purpose) => purpose === 'session', get: () => Promise.resolve({ token: 't', expires_at: Date.now() + 60000 }) }
        });
        renderPage(<SetupPage />, { crm });

        expect(await screen.findByText(/get_integration_readiness/)).toBeTruthy();
        expect(statusOf('Turn on Building Blocks')).toBe('Check');
    });
});
