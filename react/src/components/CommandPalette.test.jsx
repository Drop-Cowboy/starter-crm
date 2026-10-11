import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeCrm, renderApp } from '../test/render.jsx';

const NINA = {
    id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
    first_name: 'Nina',
    last_name: 'Patel',
    main_phone: '+15555550142',
    email: 'nina@example.com'
};

function crmWithNina() {
    return fakeCrm({
        contacts: {
            find: vi.fn((text) => Promise.resolve(text ? { contacts: [NINA], total: 1 } : { contacts: [], total: 0 })),
            get: vi.fn().mockResolvedValue(NINA)
        }
    });
}

function openPalette() {
    fireEvent.click(screen.getByRole('button', { name: 'Search or run a command' }));
    return screen.getByRole('dialog', { name: 'Command palette' });
}

afterEach(cleanup);

describe('command palette', () => {
    it('opens from the top bar and from Cmd+K or Ctrl+K', () => {
        renderApp({ crm: crmWithNina(), path: '/pipeline' });
        const palette = openPalette();
        expect(palette.open).toBe(true);

        // A browser closes the dialog on Escape; jsdom needs it done for it.
        act(() => palette.close());
        expect(palette.open).toBe(false);

        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        expect(palette.open).toBe(true);
    });

    it('lists pages with the first one selected, and moves with the arrow keys', () => {
        renderApp({ crm: crmWithNina(), path: '/pipeline' });
        const palette = openPalette();
        const input = within(palette).getByRole('combobox', { name: 'Search contacts or run a command' });
        const options = within(palette).getAllByRole('option');

        expect(options.map((o) => o.textContent.replace('↵', ''))).toEqual(
            expect.arrayContaining(['Go to Contacts', 'Go to Pipeline', 'Go to Inbox', 'Go to Campaigns', 'Go to Phone', 'Go to Setup'])
        );
        expect(options[0].getAttribute('aria-selected')).toBe('true');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

        fireEvent.keyDown(input, { key: 'ArrowDown' });

        expect(within(palette).getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
        expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    });

    it('finds a contact as you type and opens it with Enter', async () => {
        const crm = crmWithNina();
        renderApp({ crm, path: '/pipeline' });
        const palette = openPalette();
        const input = within(palette).getByRole('combobox');

        fireEvent.change(input, { target: { value: 'nina' } });

        const contact = await within(palette).findByRole('option', { name: /^Nina Patel/ });
        expect(contact.getAttribute('aria-selected')).toBe('true');
        expect(within(palette).getByRole('option', { name: /^Call Nina Patel/ })).toBeTruthy();
        expect(crm.contacts.find).toHaveBeenCalledWith('nina', { offset: 0, limit: 5 });

        fireEvent.keyDown(input, { key: 'Enter' });

        expect(palette.open).toBe(false);
        expect(await screen.findByRole('heading', { level: 1, name: 'Nina Patel' })).toBeTruthy();
    });

    it('goes to a page by name', () => {
        renderApp({ crm: crmWithNina(), path: '/pipeline' });
        const palette = openPalette();

        fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'go setup' } });
        fireEvent.click(within(palette).getByRole('option', { name: /Setup/ }));

        expect(screen.getByRole('heading', { level: 1, name: 'Setup' })).toBeTruthy();
    });

    it('says when nothing matches', () => {
        renderApp({ crm: crmWithNina(), path: '/pipeline' });
        const palette = openPalette();

        fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'go nowhere' } });

        expect(within(palette).queryAllByRole('option')).toHaveLength(0);
        expect(within(palette).getByText('No matches for "go nowhere".')).toBeTruthy();
    });
});
