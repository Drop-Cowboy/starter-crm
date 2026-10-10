import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createActivityLog } from '@shared/activity.js';
import { App } from '../App.jsx';
import { ToastProvider } from '../components/Toasts.jsx';
import { CrmContext } from '../crm-context.js';

/** A stand-in for startCrm()'s result. Tests override only what they use. */
export function fakeCrm(overrides) {
    const crm = {
        config: { auth_mode: 'server', site_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', cdn_version: '3.33.6' },
        login: null,
        widgetApiBase: 'https://app-api-v2.dropcowboy.com',
        tokens: {
            supports: () => true,
            get: () => Promise.resolve({ token: 'test-token', expires_at: Date.now() + 600000 }),
            refresh: () => Promise.resolve({ token: 'test-token', expires_at: Date.now() + 600000 })
        },
        contacts: {},
        activity: createActivityLog(),
        cdn: { loadElements: () => Promise.resolve() },
        readiness: () => Promise.resolve(null),
        needsSignIn: () => false,
        startContacts: () => Promise.resolve({ getTokenManager: () => ({ purpose: 'contacts' }) }),
        startDock: () => Promise.reject(new Error('no dock in tests'))
    };
    return Object.assign(crm, overrides);
}

/**
 * Renders `element` at `path` inside the same providers the app uses.
 * @param {import('react').ReactElement} element
 * @param {{ crm: object, path?: string, route?: string }} options
 */
export function renderPage(element, { crm, path = '/', route = '/' }) {
    return render(
        <CrmContext value={crm}>
            <ToastProvider>
                <MemoryRouter initialEntries={[path]}>
                    <Routes>
                        <Route path={route} element={element} />
                        <Route path="*" element={<p>Navigated away</p>} />
                    </Routes>
                </MemoryRouter>
            </ToastProvider>
        </CrmContext>
    );
}

/**
 * Renders the whole app, shell and routes, at `path`.
 * @param {{ crm: object, path?: string }} options
 */
export function renderApp({ crm, path = '/contacts' }) {
    return render(
        <CrmContext value={crm}>
            <MemoryRouter initialEntries={[path]}>
                <App />
            </MemoryRouter>
        </CrmContext>
    );
}

/**
 * Pretends the window is `width` CSS pixels wide, for the layout's media
 * queries. Undo with clearScreenWidth().
 */
export function setScreenWidth(width) {
    window.matchMedia = (query) => {
        const min = /min-width:\s*([\d.]+)rem/.exec(query);
        const max = /max-width:\s*([\d.]+)rem/.exec(query);
        const matches = min ? width >= Number(min[1]) * 16 : max ? width <= Number(max[1]) * 16 : false;
        return { matches, media: query, addEventListener() {}, removeEventListener() {} };
    };
}

export function clearScreenWidth() {
    delete window.matchMedia;
}
