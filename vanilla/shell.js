import { formatDate } from '/shared/format.js';
import { isCurrentPath, MODULES, NAV_PAGES, readLayout, SETUP_PAGE, showsContactList } from '/shared/ui.js';
import { h, icon, show } from './dom.js';

// The context rail opens by itself on contact pages this wide. Below it, the
// main region needs the room and the rail waits to be asked for.
const WIDE = '(min-width: 85rem)';
const PHONE = '(max-width: 47.99rem)';

function navItem(href, label, iconName, extra) {
    return h('li', null,
        h('a', { href, class: extra && extra.className, title: label, 'aria-label': (extra && extra.ariaLabel) || null },
            icon(iconName),
            h('span', { class: 'nl' }, label)
        )
    );
}

function contactFacts(contact) {
    return h('section', { class: 'ctx-sec', 'aria-labelledby': 'context-contact-heading' },
        h('h3', { class: 'ah', id: 'context-contact-heading' }, 'Details'),
        contact.created_at ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Created'), ' ', h('span', null, formatDate(contact.created_at))) : null,
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Do not call:'), ' ', h('span', null, contact.dnc ? 'On list' : 'Not listed')),
        h('a', { class: 'ctx-link', href: '/pipeline' }, 'Open in Pipeline ', icon('arrow-right'))
    );
}

/**
 * The app frame around every page: navigation, the regions' layout state on
 * .app (data-layout, data-nav, data-list, data-context), the context region
 * as a rail or a drawer, and the Activity button's count.
 */
export function createShell() {
    const app = document.getElementById('app');
    const nav = app.querySelector('[data-region="nav"]');
    const main = document.getElementById('main');
    const heading = document.getElementById('context-heading');
    const closeButton = document.getElementById('context-close');
    const activityButton = document.getElementById('activity-button');
    const count = activityButton.querySelector('.cnt');
    const scrim = app.querySelector('.drawer-scrim');
    const facts = document.getElementById('context-contact');
    const wide = window.matchMedia(WIDE);
    const phone = window.matchMedia(PHONE);

    let contactPage = false;
    let railChoice = null;
    let drawer = false;
    let unseen = 0;

    const navToggle = h('button', {
        class: 'nav-toggle',
        type: 'button',
        'aria-controls': 'app',
        onclick: () => setNav(app.getAttribute('data-nav') === 'expanded' ? 'collapsed' : 'expanded')
    });

    show(nav,
        h('ul', { class: 'nav-list' }, NAV_PAGES.map((page) => navItem(page.path, page.label, page.icon))),
        h('div', { class: 'nav-sec', id: 'modules-heading' }, 'Your modules'),
        h('ul', { class: 'nav-list mods', 'aria-labelledby': 'modules-heading' },
            MODULES.map((mod) => navItem('/modules/' + mod.id, mod.label, mod.icon)),
            navItem('/modules/add', 'Add yours', 'plus-square', { className: 'addmod', ariaLabel: 'Add your module' })
        ),
        h('span', { class: 'sp' }),
        h('ul', { class: 'nav-list bottom' }, navItem(SETUP_PAGE.path, SETUP_PAGE.label, SETUP_PAGE.icon)),
        navToggle
    );

    function setNav(state) {
        const expanded = state === 'expanded';
        app.setAttribute('data-nav', state);
        navToggle.setAttribute('aria-expanded', String(expanded));
        navToggle.setAttribute('aria-label', expanded ? 'Collapse navigation' : 'Expand navigation');
        show(navToggle, icon(expanded ? 'chevrons-left' : 'chevrons-right'), h('span', { class: 'nl', 'aria-hidden': 'true' }, 'Collapse'));
    }

    function railOpen() {
        return contactPage && !phone.matches && (railChoice === null ? wide.matches : railChoice);
    }

    function mode() {
        if (drawer) {
            return 'drawer';
        }
        return railOpen() ? 'rail' : 'closed';
    }

    function drawCount() {
        count.hidden = unseen === 0;
        count.textContent = String(unseen);
        activityButton.setAttribute('aria-label', unseen ? 'Activity, ' + unseen + ' new' : 'Activity');
    }

    function sync() {
        const now = mode();
        app.setAttribute('data-context', now);
        heading.textContent = now === 'drawer' ? 'Activity' : 'Context';
        show(closeButton, icon(now === 'drawer' ? 'x' : 'chevron-right'));
        scrim.hidden = now !== 'drawer';
        activityButton.setAttribute('aria-expanded', String(now !== 'closed'));
        for (const button of document.querySelectorAll('.ctx-toggle')) {
            button.setAttribute('aria-expanded', String(now === 'rail'));
            button.setAttribute('aria-label', now === 'rail' ? 'Hide context panel' : 'Show context panel');
            button.setAttribute('title', now === 'rail' ? 'Hide context panel' : 'Show context panel');
        }
        if (now !== 'closed') {
            unseen = 0;
        }
        drawCount();
    }

    function openDrawer() {
        drawer = true;
        sync();
        closeButton.focus();
    }

    function closeDrawer(returnFocus) {
        if (!drawer) {
            return;
        }
        drawer = false;
        sync();
        if (returnFocus) {
            activityButton.focus();
        }
    }

    function toggleRail() {
        railChoice = !railOpen();
        drawer = false;
        sync();
    }

    activityButton.addEventListener('click', () => {
        const now = mode();
        if (now === 'drawer') {
            closeDrawer(true);
        } else if (now === 'rail' || (contactPage && wide.matches && !phone.matches)) {
            toggleRail();
        } else {
            openDrawer();
        }
    });
    closeButton.addEventListener('click', () => {
        if (drawer) {
            closeDrawer(true);
            return;
        }
        toggleRail();
        const toggle = main.querySelector('.ctx-toggle');
        (toggle || main).focus();
    });
    scrim.addEventListener('click', () => closeDrawer(true));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && drawer && !document.querySelector('dialog[open]')) {
            event.preventDefault();
            closeDrawer(true);
        }
    });
    wide.addEventListener('change', sync);
    phone.addEventListener('change', sync);

    setNav('collapsed');

    return {
        /** Called on every navigation, before the page renders. */
        route(path) {
            const withList = showsContactList(path);
            app.setAttribute('data-layout', readLayout(location.search));
            app.setAttribute('data-list', withList ? 'on' : 'off');
            if (withList) {
                const selection = path === '/contacts/new' ? 'new' : (path.startsWith('/contacts/') ? 'contact' : 'none');
                app.setAttribute('data-selection', selection);
            } else {
                app.removeAttribute('data-selection');
            }
            contactPage = path.startsWith('/contacts/') && path !== '/contacts/new';
            drawer = false;
            facts.replaceChildren();
            for (const link of nav.querySelectorAll('a')) {
                if (isCurrentPath(path, link.getAttribute('href'))) {
                    link.setAttribute('aria-current', 'page');
                } else {
                    link.removeAttribute('aria-current');
                }
            }
            sync();
        },
        /** Re-reads the state of every .ctx-toggle, after a page draws one. */
        sync,
        toggleRail,
        /** Counts an entry that arrived while the Activity list was out of sight. */
        noteActivity() {
            if (mode() === 'closed') {
                unseen += 1;
                drawCount();
            }
        },
        /** Fills the contact facts in the context region. Navigating clears them. */
        setContact(contact) {
            show(facts, contactFacts(contact));
        }
    };
}
