import { cdnVersionFor } from '/shared/config.js';
import { signInCode } from '/shared/errors.js';
import { isSandboxOnly, sandboxNotice, sessionReadyNotice } from '/shared/sandbox.js';
import { getBusinessNumber, setBusinessNumber } from '/shared/settings.js';
import { isReady, itemStatus, setupChecklist, webhookItem } from '/shared/setup.js';
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

/** The session status notice, and whether the session token was minted. */
async function sessionStatus(crm) {
    if (crm.needsSignIn()) {
        return { ok: false, notice: errorNotice({ code: signInCode(crm) }, crm) };
    }
    try {
        await crm.tokens.get('session');
        return { ok: true, notice: readyNotice(null) };
    } catch (err) {
        return { ok: false, notice: errorNotice(err, crm) };
    }
}

/** "Session token: ready", worded for sandbox mode once readiness says so. */
function readyNotice(readiness) {
    const notice = sessionReadyNotice(readiness);
    return infoNotice(notice.title, notice.message);
}

/** The sandbox notice above the checklist, or null when readiness does not report sandbox_only. */
function sandboxCard(readiness) {
    const notice = sandboxNotice(readiness);
    return notice ? infoNotice(notice.title, notice.message) : null;
}

/** Setup: how this app authenticates, what the account still needs, and local settings. */
export async function renderSetup(main, { crm, isCurrent }) {
    const status = h('div', null, loading('Checking the session…'));
    const checklist = h('div', { 'aria-live': 'polite' }, loading('Checking your account…'));
    const webhooks = h('div', { 'aria-live': 'polite' }, loading('Checking webhook handling…'));
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
        h('section', { class: 'card', 'aria-labelledby': 'webhooks-title' },
            h('h2', { id: 'webhooks-title' }, 'Webhooks'),
            webhooks
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

    const session = await sessionStatus(crm);
    show(status, session.notice);
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
    if (!isCurrent()) {
        return undefined;
    }
    // A sandbox-only token works, but for 555 test numbers only: say so
    // instead of promising real calls.
    if (session.ok && isSandboxOnly(readiness)) {
        show(status, readyNotice(readiness));
    }
    const items = setupChecklist(readiness, { siteId: crm.config.site_id, businessNumber: getBusinessNumber() });
    show(checklist,
        readinessError ? errorNotice(readinessError, crm) : null,
        sandboxCard(readiness),
        h('p', null, checklistSummary(crm, readiness, items)),
        h('ol', { class: 'checklist' }, items.map(checklistItem))
    );

    let webhookStatus = null;
    if (!crm.needsSignIn()) {
        try {
            webhookStatus = await crm.webhookStatus();
        } catch {
            // The item says the server could not be asked.
        }
    }
    if (!isCurrent()) {
        return undefined;
    }
    show(webhooks, h('ol', { class: 'checklist' }, checklistItem(webhookItem(webhookStatus))));

    if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) {
            target.scrollIntoView();
            target.focus();
        }
    }
    return undefined;
}
