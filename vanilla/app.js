import { startCrm } from '/shared/crm.js';
import { explainError } from '/shared/errors.js';
import { getThemeChoice, setThemeChoice } from '/shared/settings.js';
import {
    applyThemeChoice,
    isPaletteShortcut,
    nextThemeChoice,
    readLayout,
    showsContactList,
    syncWidgetTheme,
    THEME_DISPLAY,
    themeButtonLabel
} from '/shared/ui.js';
import { startActivityFeed, toast } from './activity.js';
import { createContactList } from './contact-list.js';
import { h, icon, show } from './dom.js';
import { bannerNotice, errorNotice } from './notice.js';
import { createPalette } from './palette.js';
import { createRouter } from './router.js';
import { createShell } from './shell.js';
import { showSignIn } from './sign-in.js';
import { renderCampaigns } from './pages/campaigns.js';
import { renderContact } from './pages/contact.js';
import { renderContacts } from './pages/contacts.js';
import { renderInbox } from './pages/inbox.js';
import { renderModule } from './pages/module.js';
import { renderNewContact } from './pages/new-contact.js';
import { renderNotFound } from './pages/not-found.js';
import { renderPhone } from './pages/phone.js';
import { renderPipeline } from './pages/pipeline.js';
import { renderSetup } from './pages/setup.js';

const ROUTES = [
    { path: '/', title: 'Contacts', render: renderContacts },
    { path: '/contacts', title: 'Contacts', render: renderContacts },
    { path: '/contacts/new', title: 'Add a contact', render: renderNewContact },
    { path: '/contacts/:id', title: 'Contact', render: renderContact },
    { path: '/pipeline', title: 'Pipeline', render: renderPipeline },
    { path: '/inbox', title: 'Inbox', render: renderInbox },
    { path: '/campaigns', title: 'Campaigns', render: renderCampaigns },
    { path: '/phone', title: 'Phone', render: renderPhone },
    { path: '/setup', title: 'Setup', render: renderSetup },
    { path: '/modules/:id', title: 'Module', render: renderModule },
    { path: '*', title: 'Not found', render: renderNotFound }
];

const main = document.getElementById('main');
const banner = document.getElementById('banner');

function renderAccount(crm) {
    const mode = h('span', { class: 'modepill' }, icon('key'), 'Mode: ' + crm.config.auth_mode);
    let status = null;
    if (crm.login) {
        status = h('span', null, 'Sign-in not set up');
        if (crm.login.isSignedIn()) {
            status = h('span', null, 'Signed in');
        } else if (crm.login.isConfigured()) {
            status = h('button', { type: 'button', class: 'btn primary sm', onclick: () => crm.login.signIn(location.pathname) }, 'Sign in with Drop Cowboy');
        }
    }
    if (crm.config.auth_mode === 'server' && crm.identity.current().identity === 'passcode') {
        status = h('button', {
            type: 'button',
            class: 'btn sm',
            onclick: () => crm.identity.signOut().then(
                () => location.reload(),
                (err) => toast('Could not sign out: ' + err.message)
            )
        }, 'Sign out');
    }
    show(document.getElementById('account'), mode, status);
    document.getElementById('activity-mode').textContent = 'Mode: ' + crm.config.auth_mode;
}

function showBanner(err, crm) {
    show(banner, bannerNotice(err, crm, () => banner.replaceChildren()));
}

/** The Dock is mounted once, for every page, and stays across navigation. */
async function mountDock(crm) {
    if (crm.needsSignIn() || !crm.cdn) {
        return;
    }
    try {
        const dock = await crm.startDock();
        // Dock errors carry a code, and for consent a reason. Explain them
        // instead of showing the raw message.
        dock.addErrorListener((detail) => {
            const g = explainError(detail);
            toast(g.title + ': ' + g.message);
        });
    } catch (err) {
        showBanner(err, crm);
    }
}

function contactIdOf(path) {
    const match = /^\/contacts\/([^/]+)$/.exec(path);
    return match && match[1] !== 'new' ? decodeURIComponent(match[1]) : null;
}

/** Applies the saved theme, and lets the top bar's button move through system, light and dark. */
function startTheme() {
    const button = document.getElementById('theme-button');
    let choice = getThemeChoice();
    function draw() {
        applyThemeChoice(document.documentElement, choice);
        button.setAttribute('aria-label', themeButtonLabel(choice));
        button.setAttribute('title', themeButtonLabel(choice));
        show(button, icon(THEME_DISPLAY[choice].icon), h('span', { class: 'tlb' }, THEME_DISPLAY[choice].label));
    }
    draw();
    syncWidgetTheme(document.documentElement);
    button.addEventListener('click', () => {
        choice = setThemeChoice(nextThemeChoice(choice));
        draw();
    });
}

async function boot() {
    startTheme();
    const shell = createShell();
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
        document.querySelector('.cmdk kbd').textContent = 'Ctrl K';
    }

    let crm;
    try {
        crm = await startCrm({ basePath: '' });
    } catch (err) {
        show(main, h('div', { class: 'page' }, errorNotice(err, { login: null }, { full: true })));
        return;
    }
    if (crm.returnTo) {
        history.replaceState(null, '', crm.returnTo);
    }
    if (crm.startupError) {
        showBanner(crm.startupError, crm);
    }

    // Fired by any widget's token manager when it can no longer get a token.
    window.addEventListener('dc-session-expired', () => {
        showBanner({ code: crm.login ? 'login_expired' : 'unauthorized' }, crm);
    });

    // Your own server's identity says nobody is signed in: show the sign-in
    // screen and stop, so no page asks for data it would only be refused.
    if (crm.config.auth_mode === 'server' && crm.needsSignIn()) {
        showSignIn(crm);
        return;
    }

    renderAccount(crm);
    startActivityFeed(crm, { onItem: () => shell.noteActivity() });
    mountDock(crm);

    const contactList = createContactList({ crm, region: document.querySelector('[data-region="list"]') });
    const router = createRouter({
        routes: ROUTES,
        main,
        context: { crm, shell, contactList },
        onChange: (path) => {
            shell.route(path);
            if (showsContactList(path)) {
                contactList.start();
                contactList.select(contactIdOf(path));
            }
        },
        onError: (err, target) => show(target, h('div', { class: 'page' }, h('h1', null, 'This page could not load'), errorNotice(err, crm)))
    });

    const palette = createPalette({ crm, navigate: router.navigate });
    document.getElementById('palette-button').addEventListener('click', () => palette.open());
    document.addEventListener('keydown', (event) => {
        if (readLayout(location.search) === 'full' && isPaletteShortcut(event) && !document.querySelector('dialog[open]')) {
            event.preventDefault();
            palette.open();
        }
    });

    router.start();
}

boot();
