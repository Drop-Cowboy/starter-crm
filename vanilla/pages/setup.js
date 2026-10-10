import { cdnVersionFor } from '/shared/config.js';
import { getBusinessNumber, setBusinessNumber } from '/shared/settings.js';
import { isReady, itemStatus, setupChecklist } from '/shared/setup.js';
import { toast } from '../activity.js';
import { h, show } from '../dom.js';
import { errorNotice, infoNotice, loading } from '../notice.js';
import { page } from '../page.js';

const MODE_TEXT = {
    server: 'This server holds your API key and mints a short-lived site token whenever the page asks for one. '
        + 'The browser names a purpose (session, contacts, campaigns or phone); the server picks the scopes.',
    login: 'You sign in with your Drop Cowboy account. The page sends that sign-in to this server, which uses it to mint '
        + 'site tokens for you. No API key is needed, and the sign-in lives in this tab\'s memory only.',
    'mcp-session': 'Development only. Your AI agent minted a session token with the Drop Cowboy MCP and wrote it to '
        + '.dropcowboy/session.json. This server hands it to the page on localhost only, and every page that can use it, '
        + 'the contacts pages included, shares it.'
};

function checklistItem(item) {
    const status = itemStatus(item);
    return h('li', { id: item.id, tabindex: '-1' },
        h('span', { class: 'status ' + status.className }, status.label),
        h('div', null,
            h('strong', null, item.title),
            h('p', null, item.help),
            item.link ? h('a', { href: item.link.href, target: '_blank', rel: 'noopener' }, item.link.label + ' (opens Drop Cowboy)') : null
        )
    );
}

function businessNumberForm() {
    const input = h('input', { id: 'business-number-input', type: 'tel', autocomplete: 'tel', value: getBusinessNumber() });
    const form = h('form', { class: 'bizrow' },
        h('div', { class: 'field' }, h('label', { for: 'business-number-input' }, 'Business number (texts are sent from it)'), input),
        h('button', { type: 'submit', class: 'btn' }, 'Save number')
    );
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const saved = setBusinessNumber(input.value);
        input.value = saved;
        toast(saved ? 'Business number saved. Reload to use it in the Dock.' : 'Business number cleared.');
    });
    return form;
}

function checklistSummary(crm, readiness, items) {
    if (readiness) {
        return isReady(items) ? 'Everything required is in place.' : 'Work through the items marked "To do", then reload this page.';
    }
    if (crm.config.auth_mode === 'mcp-session') {
        return 'This mode cannot ask Drop Cowboy about your account. Your AI agent can, with get_integration_readiness.';
    }
    return 'Your account could not be checked right now, so nothing is marked.';
}

async function sessionStatus(crm) {
    if (crm.needsSignIn()) {
        return errorNotice({ code: crm.login.isConfigured() ? 'login_required' : 'login_not_configured' }, crm);
    }
    try {
        await crm.tokens.get('session');
        return infoNotice('Session token: ready', 'Calling, texting and the inbox in the Dock are available.');
    } catch (err) {
        return errorNotice(err, crm);
    }
}

/** Setup: how this app authenticates, what the account still needs, and local settings. */
export async function renderSetup(main, { crm, isCurrent }) {
    const status = h('div', null, loading('Checking the session…'));
    const checklist = h('div', { 'aria-live': 'polite' }, loading('Checking your account…'));
    let cdnVersion = '(invalid)';
    try {
        cdnVersion = cdnVersionFor(crm.config);
    } catch {
        // Shown as invalid; the banner explains.
    }

    show(main, page('Setup', 'How this app signs in, what your account still needs, and local settings.',
        h('section', { class: 'card', 'aria-labelledby': 'mode-title' },
            h('h2', { id: 'mode-title' }, 'How this app signs in: ' + crm.config.auth_mode),
            h('p', null, MODE_TEXT[crm.config.auth_mode] || ''),
            status
        ),
        h('section', { class: 'card', 'aria-labelledby': 'checklist-title' },
            h('h2', { id: 'checklist-title' }, 'Account checklist'),
            checklist
        ),
        h('section', { class: 'card', 'aria-labelledby': 'business-number-title' },
            h('h2', { id: 'business-number-title' }, 'Business number'),
            h('p', { class: 'hint' }, 'Stored in this browser only. It must be a number on your account that is registered for texting.'),
            businessNumberForm()
        ),
        h('section', { class: 'card', 'aria-labelledby': 'details-title' },
            h('h2', { id: 'details-title' }, 'Details'),
            h('dl', { class: 'dl' },
                h('dt', null, 'Site id'), h('dd', { class: 'mono' }, crm.config.site_id || 'not set'),
                h('dt', null, 'Building Blocks release'), h('dd', { class: 'mono' }, cdnVersion),
                h('dt', null, 'Widget API'), h('dd', { class: 'mono' }, crm.widgetApiBase)
            )
        )
    ));

    show(status, await sessionStatus(crm));
    if (!isCurrent()) {
        return undefined;
    }

    let readiness = null;
    let readinessError = null;
    if (!crm.needsSignIn()) {
        try {
            readiness = await crm.readiness();
        } catch (err) {
            readinessError = err;
        }
    }
    const items = setupChecklist(readiness, { siteId: crm.config.site_id, businessNumber: getBusinessNumber() });
    show(checklist,
        readinessError ? errorNotice(readinessError, crm) : null,
        h('p', null, checklistSummary(crm, readiness, items)),
        h('ol', { class: 'checklist' }, items.map(checklistItem))
    );

    if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) {
            target.scrollIntoView();
            target.focus();
        }
    }
    return undefined;
}
