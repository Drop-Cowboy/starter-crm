import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromWebhook } from '@shared/activity.js';
import { AppError } from '@shared/errors.js';
import { clearScreenWidth, fakeCrm, renderApp, setScreenWidth } from '../test/render.jsx';

const ADA = {
    id: '8f3e1a9c-2d4b-4e7a-9c1f-5b6a7c8d9e0f',
    first_name: 'Ada',
    last_name: 'Lovelace',
    main_phone: '+15555550101',
    created_at: '2026-03-02T15:04:05Z'
};

function crmWithAda(overrides) {
    return fakeCrm(Object.assign({
        contacts: {
            find: vi.fn().mockResolvedValue({ contacts: [ADA], total: 1 }),
            get: vi.fn().mockResolvedValue(ADA)
        }
    }, overrides));
}

function textReceived(id, contactId) {
    return fromWebhook({ event_id: id, event: 'contact.msg.received', data: { contact_id: contactId, from: '+15555550101' } });
}

function app() {
    return document.getElementById('app');
}

afterEach(() => {
    cleanup();
    clearScreenWidth();
});

describe('navigation', () => {
    it('marks the current page and keeps modules and Setup in the nav', async () => {
        renderApp({ crm: crmWithAda(), path: '/pipeline' });
        const nav = screen.getByRole('navigation', { name: 'Main' });

        expect(within(nav).getByRole('link', { name: 'Pipeline' }).getAttribute('aria-current')).toBe('page');
        expect(within(nav).getByRole('link', { name: 'Contacts' }).getAttribute('aria-current')).toBeNull();
        expect(within(nav).getByRole('list', { name: 'Your modules' })).toBeTruthy();
        expect(within(nav).getByRole('link', { name: 'Deals' }).getAttribute('href')).toBe('/modules/deals');
        expect(within(nav).getByRole('link', { name: 'Add your module' }).getAttribute('href')).toBe('/modules/add');
        expect(within(nav).getByRole('link', { name: 'Setup' }).getAttribute('href')).toBe('/setup');
        expect(app().getAttribute('data-list')).toBe('off');
    });

    it('moves focus to the page on load and after each navigation', () => {
        renderApp({ crm: crmWithAda(), path: '/pipeline' });
        const main = screen.getByRole('main');
        expect(document.activeElement).toBe(main);

        screen.getByRole('button', { name: 'Expand navigation' }).focus();
        fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));

        expect(document.activeElement).toBe(main);
    });

    it('expands and collapses', () => {
        renderApp({ crm: crmWithAda(), path: '/pipeline' });
        const toggle = screen.getByRole('button', { name: 'Expand navigation' });
        expect(app().getAttribute('data-nav')).toBe('collapsed');
        expect(screen.getByRole('link', { name: 'Inbox' }).getAttribute('title')).toBe('Inbox');

        fireEvent.click(toggle);

        expect(app().getAttribute('data-nav')).toBe('expanded');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.getAttribute('aria-label')).toBe('Collapse navigation');
    });

    it('drops the top bar and nav when embedded, and keeps links embedded', async () => {
        renderApp({ crm: crmWithAda(), path: '/contacts?layout=embedded' });

        expect(app().getAttribute('data-layout')).toBe('embedded');
        expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
        const link = await screen.findByRole('link', { name: /^Ada Lovelace/ });
        expect(link.getAttribute('href')).toBe('/contacts/' + ADA.id + '?layout=embedded');
    });

    it('shows a startup problem in the banner until dismissed', () => {
        const crm = crmWithAda({ startupError: new AppError('byoc_required', 'Connect a carrier.', { status: 403 }) });
        renderApp({ crm, path: '/pipeline' });
        const banner = document.getElementById('banner');

        expect(within(banner).getByRole('alert').textContent).toMatch(/connect your carrier/i);
        fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss notice' }));
        expect(banner.textContent).toBe('');
    });
});

describe('context panel', () => {
    it('opens the activity drawer off contact pages, closes on Escape and returns focus', () => {
        renderApp({ crm: crmWithAda(), path: '/pipeline' });
        const button = screen.getByRole('button', { name: 'Activity' });
        expect(app().getAttribute('data-context')).toBe('closed');

        fireEvent.click(button);

        expect(app().getAttribute('data-context')).toBe('drawer');
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close panel' }));
        expect(screen.getByRole('heading', { level: 2, name: 'Activity' })).toBeTruthy();

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(app().getAttribute('data-context')).toBe('closed');
        expect(document.activeElement).toBe(button);
    });

    it('closes the drawer from its scrim', () => {
        renderApp({ crm: crmWithAda(), path: '/pipeline' });
        fireEvent.click(screen.getByRole('button', { name: 'Activity' }));

        fireEvent.click(document.querySelector('.drawer-scrim'));

        expect(app().getAttribute('data-context')).toBe('closed');
    });

    it('counts new activity while the panel is closed, and clears the count on open', () => {
        const crm = crmWithAda();
        renderApp({ crm, path: '/pipeline' });

        act(() => {
            crm.activity.add(textReceived('a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b', ADA.id));
            crm.activity.add(textReceived('d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c', ADA.id));
        });
        const button = screen.getByRole('button', { name: 'Activity, 2 new' });

        fireEvent.click(button);

        expect(button.getAttribute('aria-label')).toBe('Activity');
        expect(within(screen.getByRole('list', { name: 'Recent activity' })).getAllByRole('listitem')).toHaveLength(2);
    });

    it('shows the contact rail on wide screens, with a toggle on the contact page', async () => {
        setScreenWidth(1440);
        renderApp({ crm: crmWithAda(), path: '/contacts/' + ADA.id });

        await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
        expect(app().getAttribute('data-context')).toBe('rail');
        const facts = await screen.findByRole('region', { name: 'Details' });
        expect(facts.textContent).toMatch(/Do not call: Not listed/);

        const toggle = screen.getByRole('button', { name: 'Hide context panel' });
        fireEvent.click(toggle);

        expect(app().getAttribute('data-context')).toBe('closed');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.getAttribute('aria-label')).toBe('Show context panel');

        fireEvent.click(toggle);
        expect(app().getAttribute('data-context')).toBe('rail');
        fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
        expect(app().getAttribute('data-context')).toBe('closed');
        expect(document.activeElement).toBe(toggle);
    });

    it('starts with the rail closed on narrower screens', async () => {
        setScreenWidth(1280);
        renderApp({ crm: crmWithAda(), path: '/contacts/' + ADA.id });

        await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
        expect(app().getAttribute('data-context')).toBe('closed');
        fireEvent.click(screen.getByRole('button', { name: 'Show context panel' }));
        expect(app().getAttribute('data-context')).toBe('rail');
    });

    it('closes the drawer when you follow a link out of it', async () => {
        const crm = crmWithAda();
        crm.activity.add(textReceived('a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b', ADA.id));
        renderApp({ crm, path: '/pipeline' });
        fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
        expect(app().getAttribute('data-context')).toBe('drawer');

        const feed = screen.getByRole('list', { name: 'Recent activity' });
        fireEvent.click(within(feed).getByRole('link'));

        expect(await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeTruthy();
        await waitFor(() => expect(app().getAttribute('data-context')).toBe('closed'));
    });
});
