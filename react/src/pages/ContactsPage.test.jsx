import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@shared/errors.js';
import { ContactList } from '../components/ContactList.jsx';
import { fakeCrm, renderApp, renderPage } from '../test/render.jsx';
import { NewContactPage } from './ContactsPage.jsx';

const ADA = {
    id: '8f3e1a9c-2d4b-4e7a-9c1f-5b6a7c8d9e0f',
    first_name: 'Ada',
    last_name: 'Lovelace',
    main_phone: '+15555550101',
    email: 'ada@example.com',
    company: 'Analytical Engines'
};

afterEach(cleanup);

describe('ContactList', () => {
    it('lists contacts with links to each one', async () => {
        const find = vi.fn().mockResolvedValue({ contacts: [ADA], total: 1 });
        renderPage(<ContactList />, { crm: fakeCrm({ contacts: { find } }) });

        const link = await screen.findByRole('link', { name: /^Ada Lovelace/ });
        expect(link.getAttribute('href')).toBe('/contacts/' + ADA.id);
        expect(link.getAttribute('data-contact-id')).toBe(ADA.id);
        expect(screen.getByText('Showing 1–1 of 1')).toBeTruthy();
        expect(find).toHaveBeenCalledWith('', { offset: 0, limit: 25 });
    });

    it('searches with the text typed into the search box', async () => {
        const find = vi.fn().mockResolvedValue({ contacts: [], total: 0 });
        renderPage(<ContactList />, { crm: fakeCrm({ contacts: { find } }) });

        fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: '  ada@example.com ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        expect(await screen.findByText('No contact matches "ada@example.com".')).toBeTruthy();
        expect(find).toHaveBeenLastCalledWith('ada@example.com', { offset: 0, limit: 25 });
    });

    it('explains a refused token instead of showing a raw error', async () => {
        const find = vi.fn().mockRejectedValue(new AppError('unauthorized', 'Unauthorized', { status: 401 }));
        renderPage(<ContactList />, { crm: fakeCrm({ contacts: { find } }) });

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/Session expired/);
        expect(alert.textContent).not.toMatch(/Unauthorized/);
    });

    it('lists contacts when the session mint fails with byoc_required', async () => {
        const find = vi.fn().mockResolvedValue({ contacts: [ADA], total: 1 });
        const startDock = vi.fn().mockRejectedValue(new AppError('byoc_required', 'Connect a carrier.', { status: 403 }));
        renderApp({ crm: fakeCrm({ contacts: { find }, startDock }) });

        expect(await screen.findByRole('link', { name: /^Ada Lovelace/ })).toBeTruthy();
        expect(within(document.getElementById('main')).queryByRole('alert')).toBeNull();
    });

    it('marks the open contact and stays put while you move between contacts', async () => {
        const find = vi.fn().mockResolvedValue({ contacts: [ADA], total: 1 });
        const crm = fakeCrm({ contacts: { find, get: vi.fn().mockResolvedValue(ADA) } });
        renderApp({ crm });

        expect(await screen.findByRole('heading', { level: 2, name: 'Pick a contact' })).toBeTruthy();
        const link = await screen.findByRole('link', { name: /^Ada Lovelace/ });
        fireEvent.click(link);

        expect(await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeTruthy();
        expect(screen.getByRole('link', { name: /^Ada Lovelace/ }).getAttribute('aria-current')).toBe('page');
        expect(document.getElementById('app').getAttribute('data-selection')).toBe('contact');
        expect(find).toHaveBeenCalledTimes(1);
    });
});

describe('NewContactPage', () => {
    it('opens the new contact after adding it', async () => {
        const create = vi.fn().mockResolvedValue({ contact_id: ADA.id, created: true });
        renderPage(<NewContactPage />, { crm: fakeCrm({ contacts: { create } }) });

        expect(screen.getByRole('heading', { level: 1, name: 'Add a contact' })).toBeTruthy();
        fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
        fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '(555) 555-0101' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));

        expect(await screen.findByText('Navigated away')).toBeTruthy();
        expect(create.mock.calls[0][0]).toMatchObject({ first_name: 'Ada', main_phone: '(555) 555-0101' });
    });

    it('reloads the list once the contact exists', async () => {
        const find = vi.fn().mockResolvedValue({ contacts: [], total: 0 });
        const create = vi.fn().mockResolvedValue({ contact_id: ADA.id, created: true });
        const crm = fakeCrm({ contacts: { find, create, get: vi.fn().mockResolvedValue(ADA) } });
        renderApp({ crm, path: '/contacts/new' });

        expect(await screen.findByText(/No contacts yet/)).toBeTruthy();
        fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));

        expect(await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeTruthy();
        expect(find).toHaveBeenCalledTimes(2);
    });
});
