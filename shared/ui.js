// Layout, theme and command-palette logic both front-ends share. No
// framework and no rendering: vanilla/ and react/ each draw it their own way.

import { contactName, formatPhone } from './format.js';

/** The pages in the main navigation. `icon` is a symbol in /shared/icons.svg. */
export const NAV_PAGES = [
    { path: '/contacts', label: 'Contacts', icon: 'users' },
    { path: '/pipeline', label: 'Pipeline', icon: 'kanban' },
    { path: '/inbox', label: 'Inbox', icon: 'inbox' },
    { path: '/campaigns', label: 'Campaigns', icon: 'megaphone' },
    { path: '/phone', label: 'Phone', icon: 'phone' }
];

export const SETUP_PAGE = { path: '/setup', label: 'Setup', icon: 'settings' };

/**
 * Your own screens, listed under "Your modules" in the navigation. Each one
 * opens /modules/<id>. Replace these with your app's modules, and give each a
 * real page in vanilla/pages/ and react/src/pages/.
 */
export const MODULES = [
    { id: 'deals', label: 'Deals', icon: 'briefcase' },
    { id: 'tickets', label: 'Tickets', icon: 'ticket' }
];

export const ICON_SPRITE = '/shared/icons.svg';

/** The href for an icon symbol, for <svg><use href="..."/></svg>. */
export function iconHref(name) {
    return ICON_SPRITE + '#i-' + name;
}

/** Whether a nav link to `href` is the current page for `path`. */
export function isCurrentPath(path, href) {
    return path === href || path.startsWith(href + '/') || (path === '/' && href === '/contacts');
}

/** Contacts and a contact show the list region beside the main region. */
export function showsContactList(path) {
    return path === '/' || path === '/contacts' || path.startsWith('/contacts/');
}

/**
 * "full" draws the whole app. "embedded" drops the top bar and the navigation,
 * leaving the list, main and context regions to sit inside a page of your
 * existing app. Preview it with ?layout=embedded.
 */
export function readLayout(search) {
    return new URLSearchParams(search || '').get('layout') === 'embedded' ? 'embedded' : 'full';
}

/**
 * Keeps the Drop Cowboy widgets on the same light or dark theme as the CRM.
 * The CRM follows the system setting, or <html data-theme="light|dark"> when
 * set, including when it changes later. Widgets read data-dc-theme on the
 * root. Returns a stop function.
 */
export function syncWidgetTheme(root, matchMedia, Observer) {
    const target = root || document.documentElement;
    const query = matchMedia ? matchMedia('(prefers-color-scheme: dark)') : window.matchMedia('(prefers-color-scheme: dark)');
    const ObserverClass = Observer || globalThis.MutationObserver;
    function apply() {
        const forced = target.getAttribute('data-theme');
        const dark = forced ? forced === 'dark' : query.matches;
        target.setAttribute('data-dc-theme', dark ? 'dark' : 'light');
    }
    apply();
    query.addEventListener('change', apply);
    const observer = ObserverClass ? new ObserverClass(apply) : null;
    if (observer) {
        observer.observe(target, { attributes: true, attributeFilter: ['data-theme'] });
    }
    return function stop() {
        query.removeEventListener('change', apply);
        if (observer) {
            observer.disconnect();
        }
    };
}

/** How the theme button shows each choice in THEME_CHOICES (shared/settings.js). */
export const THEME_DISPLAY = {
    system: { label: 'System', icon: 'monitor' },
    light: { label: 'Light', icon: 'sun' },
    dark: { label: 'Dark', icon: 'moon' }
};

/** The choice the theme button moves to next: system, then light, then dark. */
export function nextThemeChoice(choice) {
    return choice === 'system' ? 'light' : (choice === 'light' ? 'dark' : 'system');
}

/** The theme button's accessible name: what it is now, and what a click does. */
export function themeButtonLabel(choice) {
    const now = THEME_DISPLAY[choice] || THEME_DISPLAY.system;
    return 'Theme: ' + now.label + '. Switch to ' + THEME_DISPLAY[nextThemeChoice(choice)].label;
}

/** Sets <html data-theme> for "light" or "dark", and removes it for "system". */
export function applyThemeChoice(root, choice) {
    const target = root || document.documentElement;
    if (choice === 'light' || choice === 'dark') {
        target.setAttribute('data-theme', choice);
    } else {
        target.removeAttribute('data-theme');
    }
}

/** True for the keyboard shortcut that opens the command palette: Cmd+K or Ctrl+K. */
export function isPaletteShortcut(event) {
    return Boolean(event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 'k';
}

const VERBS = { call: 'call', text: 'text', go: 'go' };

/**
 * Splits palette input into an optional verb and the rest: "call nina" is
 * { verb: "call", rest: "nina" }. Anything else is { verb: "", rest: input }.
 */
export function parsePaletteInput(input) {
    const text = String(input || '').trim();
    const match = /^(\w+)\s+(.*)$/.exec(text);
    if (match && VERBS[match[1].toLowerCase()]) {
        return { verb: VERBS[match[1].toLowerCase()], rest: match[2].trim() };
    }
    return { verb: '', rest: text };
}

/**
 * The palette's results for `input`, given the contacts the Contacts API found
 * for the search part of it. Each item says what to do, and the front-end does
 * it: { type: "navigate", path }, or { type: "call" | "text", contact }.
 *
 * Calls and texts carry the whole contact, so they reach the Dock with its
 * contact_id, never as a bare number.
 *
 * @param {{ input: string, contacts: import('./contacts-api.js').Contact[] }} options
 */
export function paletteItems(options) {
    const { verb, rest } = parsePaletteInput(options.input);
    const needle = rest.toLowerCase();
    const contacts = (options.contacts || []).slice(0, 5);
    const reachable = contacts.filter((contact) => contact.main_phone);

    if (verb === 'call') {
        return reachable.map((contact) => callItem(contact, contactHint(contact)));
    }
    if (verb === 'text') {
        return reachable.map((contact) => textItem(contact, contactHint(contact)));
    }
    if (verb === 'go') {
        return pageItems(needle);
    }

    const items = [];
    for (const contact of contacts) {
        items.push(item('contacts', 'contact:' + contact.id, contactName(contact), contactHint(contact), 'user', { type: 'navigate', path: '/contacts/' + encodeURIComponent(contact.id) }));
    }
    if (needle && reachable.length) {
        items.push(callItem(reachable[0], ''), textItem(reachable[0], ''));
    }
    return items.concat(pageItems(needle));
}

export const PALETTE_GROUPS = { contacts: 'Contacts', actions: 'Actions', pages: 'Pages' };

function item(group, id, label, hint, icon, action) {
    return { group, id, label, hint, icon, action };
}

function contactHint(contact) {
    return [contact.company, formatPhone(contact.main_phone) || contact.email].filter(Boolean).join(' · ');
}

function callItem(contact, hint) {
    return item('actions', 'call:' + contact.id, 'Call ' + contactName(contact), hint, 'phone', { type: 'call', contact });
}

function textItem(contact, hint) {
    return item('actions', 'text:' + contact.id, 'Text ' + contactName(contact), hint, 'message', { type: 'text', contact });
}

function pageItems(needle) {
    const items = [];
    for (const page of NAV_PAGES.concat([SETUP_PAGE])) {
        if (!needle || page.label.toLowerCase().includes(needle)) {
            items.push(item('pages', 'page:' + page.path, 'Go to ' + page.label, '', page.icon, { type: 'navigate', path: page.path }));
        }
    }
    if (!needle || 'add a new contact'.includes(needle)) {
        items.push(item('pages', 'page:/contacts/new', 'Add a contact', '', 'plus', { type: 'navigate', path: '/contacts/new' }));
    }
    return items;
}
