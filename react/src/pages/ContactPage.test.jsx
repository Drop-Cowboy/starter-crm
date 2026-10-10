import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromWebhook } from '@shared/activity.js';
import { AppError } from '@shared/errors.js';
import { fakeCrm, renderPage } from '../test/render.jsx';
import { ContactPage } from './ContactPage.jsx';
import { PipelinePage } from './PipelinePage.jsx';

const ADA = {
    id: '8f3e1a9c-2d4b-4e7a-9c1f-5b6a7c8d9e0f',
    first_name: 'Ada',
    last_name: 'Lovelace',
    main_phone: '+15555550101',
    email: 'ada@example.com',
    company: 'Analytical Engines'
};

// A team with no connected carrier: the session token (and with it the Dock)
// cannot be minted, but the contacts token can.
function crmWithoutCarrier(overrides) {
    const byoc = new AppError('byoc_required', 'Connect a carrier.', { status: 403 });
    return fakeCrm(Object.assign({
        contacts: { get: vi.fn().mockResolvedValue(ADA) },
        startDock: vi.fn().mockRejectedValue(byoc)
    }, overrides));
}

afterEach(cleanup);

describe('contacts pages without a connected carrier', () => {
    it('shows the contact and its card when the session mint fails with byoc_required', async () => {
        const crm = crmWithoutCarrier();
        const { container } = renderPage(<ContactPage />, { crm, path: '/contacts/' + ADA.id, route: '/contacts/:id' });

        expect(await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeTruthy();
        await waitFor(() => expect(container.querySelector('dc-contact-card')).toBeTruthy());
        expect(screen.queryByRole('alert')).toBeNull();
        expect(crm.contacts.get).toHaveBeenCalledWith(ADA.id);
    });

    it('explains why Call is unavailable instead of breaking the page', async () => {
        renderPage(<ContactPage />, { crm: crmWithoutCarrier(), path: '/contacts/' + ADA.id, route: '/contacts/:id' });

        fireEvent.click(await screen.findByRole('button', { name: 'Call' }));

        // The app banner explains the missing carrier in full; the page points at it.
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/Calling and texting are off/);
        expect(alert.textContent).toMatch(/until you connect your carrier/);
        expect(screen.getByRole('link', { name: 'Setup: carrier' }).getAttribute('href')).toBe('/setup#connect_byoc');
        expect(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeTruthy();
    });

    it('shows the pipeline board when the session mint fails with byoc_required', async () => {
        const crm = crmWithoutCarrier();
        const { container } = renderPage(<PipelinePage />, { crm });

        await waitFor(() => expect(container.querySelector('dc-pipeline-board')).toBeTruthy());
        expect(screen.queryByRole('alert')).toBeNull();
        expect(crm.startDock).not.toHaveBeenCalled();
    });
});

function openContact(overrides) {
    const crm = fakeCrm(Object.assign({ contacts: { get: vi.fn().mockResolvedValue(ADA) } }, overrides));
    const view = renderPage(<ContactPage />, { crm, path: '/contacts/' + ADA.id, route: '/contacts/:id' });
    return Object.assign(view, { crm });
}

describe('contact page tabs', () => {
    it('moves between tabs with the arrow keys, Home and End', async () => {
        openContact();
        const overview = await screen.findByRole('tab', { name: 'Overview' });
        expect(overview.getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tabpanel', { name: 'Overview' })).toBeTruthy();

        fireEvent.keyDown(overview, { key: 'ArrowRight' });
        const activity = screen.getByRole('tab', { name: 'Activity' });
        expect(activity.getAttribute('aria-selected')).toBe('true');
        expect(activity.tabIndex).toBe(0);
        expect(overview.tabIndex).toBe(-1);
        expect(document.activeElement).toBe(activity);
        expect(screen.getByRole('tabpanel', { name: 'Activity' })).toBeTruthy();
        expect(screen.queryByRole('tabpanel', { name: 'Overview' })).toBeNull();

        fireEvent.keyDown(activity, { key: 'End' });
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Edit' }));
        fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(overview);
        fireEvent.keyDown(overview, { key: 'ArrowLeft' });
        expect(document.activeElement.textContent).toBe('Edit');
        fireEvent.keyDown(document.activeElement, { key: 'Home' });
        expect(document.activeElement).toBe(overview);
    });

    it('keeps the contact card mounted while another tab is open', async () => {
        const { container } = openContact();
        await waitFor(() => expect(container.querySelector('dc-contact-card')).toBeTruthy());
        const card = container.querySelector('dc-contact-card');

        fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
        fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));

        expect(container.querySelector('dc-contact-card')).toBe(card);
    });

    it('shows this contact\'s live activity as it arrives', async () => {
        const { crm } = openContact();
        fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
        expect(screen.getByText(/Nothing yet for Ada Lovelace/)).toBeTruthy();

        act(() => {
            crm.activity.add(fromWebhook({
                event_id: 'a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b',
                event: 'contact.msg.received',
                data: { contact_id: ADA.id, from: '+15555550101' }
            }));
            crm.activity.add(fromWebhook({
                event_id: 'd1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c',
                event: 'contact.msg.received',
                data: { contact_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', from: '+15555550102' }
            }));
        });

        const feed = screen.getByRole('list', { name: 'Activity for Ada Lovelace' });
        expect(within(feed).getAllByRole('listitem')).toHaveLength(1);
        expect(feed.textContent).toMatch(/contact\.msg\.received/);
        expect(screen.getByText(/Nothing yet for Ada Lovelace/).hidden).toBe(true);
    });
});

describe('recording consent', () => {
    it('opens the consent sheet, records consent and closes', async () => {
        const recordConsent = vi.fn().mockResolvedValue({});
        openContact({ contacts: { get: vi.fn().mockResolvedValue(ADA), recordConsent } });
        const opener = await screen.findByRole('button', { name: 'Record consent' });

        opener.focus();
        fireEvent.click(opener);
        const sheet = screen.getByRole('dialog', { name: 'Record consent' });
        expect(sheet.open).toBe(true);
        expect(document.activeElement).toBe(within(sheet).getByLabelText('Texts'));

        fireEvent.click(within(sheet).getByLabelText('Texts'));
        fireEvent.change(within(sheet).getByLabelText('What they agreed to'), { target: { value: 'I agree to texts from Example Co.' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Record consent' }));

        expect(await screen.findByText('Recorded consent for Ada Lovelace')).toBeTruthy();
        expect(recordConsent).toHaveBeenCalledWith(ADA.id, expect.objectContaining({
            phone_number: ADA.main_phone,
            channels: ['sms'],
            consent_text: 'I agree to texts from Example Co.'
        }));
        expect(sheet.open).toBe(false);
        expect(document.activeElement).toBe(opener);
    });

    it('closes the sheet with Cancel and returns focus', async () => {
        openContact();
        const opener = await screen.findByRole('button', { name: 'Record consent' });
        opener.focus();
        fireEvent.click(opener);
        const sheet = screen.getByRole('dialog', { name: 'Record consent' });

        fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));

        expect(sheet.open).toBe(false);
        expect(document.activeElement).toBe(opener);
    });
});

describe('editing and deleting', () => {
    it('saves only the changed fields', async () => {
        const update = vi.fn().mockResolvedValue(Object.assign({}, ADA, { company: 'Example Co' }));
        openContact({ contacts: { get: vi.fn().mockResolvedValue(ADA), update } });
        fireEvent.click(await screen.findByRole('tab', { name: 'Edit' }));

        const form = screen.getByRole('tabpanel', { name: 'Edit' });
        fireEvent.change(within(form).getByLabelText('Company'), { target: { value: 'Example Co' } });
        fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText('Saved Ada Lovelace')).toBeTruthy();
        expect(update).toHaveBeenCalledWith(ADA.id, { company: 'Example Co' });
    });

    it('asks before deleting, then leaves the page', async () => {
        const remove = vi.fn().mockResolvedValue({});
        openContact({ contacts: { get: vi.fn().mockResolvedValue(ADA), remove } });
        fireEvent.click(await screen.findByRole('tab', { name: 'Edit' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete contact' }));

        const dialog = screen.getByRole('dialog', { name: 'Delete Ada Lovelace?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(remove).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Delete contact' }));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete Ada Lovelace?' })).getByRole('button', { name: 'Delete contact' }));

        expect(await screen.findByText('Navigated away')).toBeTruthy();
        expect(remove).toHaveBeenCalledWith(ADA.id);
    });
});
