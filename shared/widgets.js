import { AppError } from './errors.js';
import { getBusinessNumber } from './settings.js';

// How each page hands a session to its Building Blocks. Framework-free: the
// vanilla pages and the React wrappers call the same functions.
//
// A token only ever reaches a widget as a JavaScript property (tokenManager,
// or init({ token })). Never as an HTML attribute, where it would show in the
// DOM, in devtools and in anything that serializes the page.

// Each widget gets the token for its purpose and no more:
//   contactWidgets()  contacts token: <dc-contact-card>, <dc-pipeline-board>
//   sessionWidgets()  session token, shared with the Dock: <dc-shared-inbox>

/**
 * Makes sure the contacts bundle is signed in and the given elements are
 * defined, and returns the contacts token manager for them. It does not need
 * the Dock, so it works before calling is set up.
 * @param {Awaited<ReturnType<typeof import('./crm.js').startCrm>>} crm
 * @param {string[]} tags  e.g. ["dc-contact-card"]
 */
export async function contactWidgets(crm, tags) {
    const contacts = await crm.startContacts();
    await crm.cdn.loadElements(tags);
    return { tokenManager: contacts.getTokenManager() };
}

/**
 * Makes sure the Dock is signed in and the given elements are defined, and
 * returns the Dock's session token manager for them to borrow.
 * @param {Awaited<ReturnType<typeof import('./crm.js').startCrm>>} crm
 * @param {string[]} tags  e.g. ["dc-shared-inbox"]
 */
export async function sessionWidgets(crm, tags) {
    const dock = await crm.startDock();
    await crm.cdn.loadElements(tags);
    return { dock, tokenManager: dock.getTokenManager() };
}

// The Dock is told who the contact is by contact_id, not just by number.
// Drop Cowboy then logs the call or text on that contact, and the team's
// "Use existing contact consent" setting can apply the consent on file.
function dockTarget(contact) {
    return { contact_id: contact.id, phone: contact.main_phone || undefined };
}

/** Binds the Dock to the contact on screen, or clears it with null. */
export async function focusContact(crm, contact) {
    const dock = await crm.startDock();
    await dock.setContact(contact ? dockTarget(contact) : null);
}

export async function callContact(crm, contact) {
    const dock = await crm.startDock();
    await dock.dial(dockTarget(contact));
}

/** Texting needs the business number the text is sent from. */
export async function textContact(crm, contact) {
    if (!getBusinessNumber()) {
        throw new AppError('business_number_missing', 'Set a business number first.');
    }
    const dock = await crm.startDock();
    await dock.text(dockTarget(contact));
}

/**
 * <dc-contact-card> and <dc-pipeline-board> load their own data once they
 * have an API base and a token manager.
 */
export function connectContactWidget(el, crm, tokenManager) {
    el.apiBase = crm.widgetApiBase;
    el.tokenManager = tokenManager;
}

/** <dc-shared-inbox> also needs the business number replies are sent from. */
export function connectInbox(el, crm, tokenManager) {
    el.phoneApiBase = crm.widgetApiBase;
    const from = getBusinessNumber();
    if (from) {
        el.from = from;
    }
    el.tokenManager = tokenManager;
}

/**
 * Opens the read-only campaign hub in `container` with its own campaigns
 * token. Resolves to a close() function for when the page goes away.
 */
export async function openCampaignHub(crm, container) {
    if (!crm.tokens.supports('campaigns')) {
        throw new AppError('purpose_unavailable', 'Campaigns need their own token.');
    }
    const campaigns = await crm.cdn.loadApi('campaigns');
    const first = await crm.tokens.get('campaigns');
    await campaigns.init({
        token: first.token,
        expires_at: first.expires_at,
        getToken: function () {
            return crm.tokens.refresh('campaigns');
        },
        campaignApiBase: crm.widgetApiBase
    });
    await campaigns.open({ container });
    return function close() {
        container.replaceChildren();
        return campaigns.close();
    };
}

/**
 * Signs in the phone hub bundle with the phone token, which can rent numbers.
 * No other page gets this token. Renting asks first, because startCrm() set
 * window.DropCowboy.confirmSpend.
 *
 * After init, every <dc-phone-hub> and <dc-number-picker> on the page, now
 * or later, is handed the session by the bundle itself.
 */
export async function startPhoneHub(crm, hubContainer) {
    if (!crm.tokens.supports('phone')) {
        throw new AppError('purpose_unavailable', 'Phone needs its own token.');
    }
    const phoneHub = await crm.cdn.loadApi('phoneHub');
    const first = await crm.tokens.get('phone');
    await phoneHub.init({
        token: first.token,
        expires_at: first.expires_at,
        getToken: function () {
            return crm.tokens.refresh('phone');
        },
        phoneApiBase: crm.widgetApiBase
    });
    await phoneHub.openHub({ container: hubContainer });
    return function close() {
        return phoneHub.close();
    };
}
