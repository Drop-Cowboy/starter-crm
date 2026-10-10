import { createActivityLog, fromDock } from './activity.js';
import { cdnVersionFor, loadConfig, WIDGET_API_BASE } from './config.js';
import { createContactsApi } from './contacts-api.js';
import { createCdnLoader } from './dropcowboy-cdn.js';
import { createLogin } from './login.js';
import { callServer } from './server-api.js';
import { getBusinessNumber } from './settings.js';
import { createTokenProvider, createTokenStore } from './token-provider.js';

// Everything a page needs, wired once at startup. Both front-ends call
// startCrm() and then only use what it returns, so the vanilla and React apps
// differ in rendering only, never in how they talk to Drop Cowboy.

/**
 * @param {{ basePath?: string }} [options]  "/react" for the React build, "" for vanilla.
 */
export async function startCrm(options) {
    const basePath = (options && options.basePath) || '';

    // Set before any bundle loads: a widget that spends money (renting a
    // number) asks the user with window.confirm() first.
    window.DropCowboy = window.DropCowboy || {};
    window.DropCowboy.confirmSpend = true;

    const config = await loadConfig();
    const login = config.auth_mode === 'login'
        ? createLogin({ auth0: config.auth0 || { domain: '', client_id: null, audience: '' }, redirectUri: window.location.origin + basePath + '/' })
        : null;

    let returnTo = null;
    let startupError = null;
    if (login) {
        try {
            returnTo = await login.handleCallback();
        } catch (err) {
            startupError = err;
        }
    }

    const provider = createTokenProvider({ config, login });
    const tokens = createTokenStore(provider);
    let cdn = null;
    try {
        cdn = createCdnLoader({ version: cdnVersionFor(config) });
    } catch (err) {
        startupError = startupError || err;
    }

    const crm = {
        config,
        login,
        tokens,
        cdn,
        contacts: createContactsApi({ tokens, apiBase: WIDGET_API_BASE }),
        activity: createActivityLog(),
        returnTo,
        startupError,
        widgetApiBase: WIDGET_API_BASE,
        readiness: function () {
            return readReadiness(config, provider);
        },
        startDock: function () {
            return startDock(crm);
        },
        startContacts: function () {
            return startContacts(crm);
        },
        /** True in login mode until the user signs in. */
        needsSignIn: function () {
            return !!login && !login.isSignedIn();
        }
    };
    return crm;
}

/** GET /api/dropcowboy/readiness, or null in mcp-session mode, which has no such route. */
function readReadiness(config, provider) {
    if (config.auth_mode === 'mcp-session') {
        return Promise.resolve(null);
    }
    return callServer('/api/dropcowboy/readiness', { headers: provider.authHeaders() });
}

let dockStarted = null;
let contactsStarted = null;

/**
 * Loads the contacts bundle and signs it in with the contacts token, once per
 * page load. It creates the contacts token manager that the contact card and
 * the pipeline board share, through DropCowboy.contacts.getTokenManager().
 *
 * It never waits for the Dock, so the contacts pages keep working when the
 * session token cannot be minted (no carrier connected, no balance).
 */
function startContacts(crm) {
    if (!contactsStarted) {
        contactsStarted = initContacts(crm).catch(function (err) {
            contactsStarted = null;
            throw err;
        });
    }
    return contactsStarted;
}

async function initContacts(crm) {
    const contacts = await crm.cdn.loadApi('contacts');
    const first = await crm.tokens.get('contacts');
    await contacts.init({
        token: first.token,
        expires_at: first.expires_at,
        getToken: function () {
            return crm.tokens.refresh('contacts');
        },
        apiBase: crm.widgetApiBase
    });
    return contacts;
}

/**
 * Loads the Dock bundle and signs it in, once per page load. The Dock
 * creates the session token manager its panes use; the inbox borrows it
 * through DropCowboy.dock.getTokenManager().
 */
function startDock(crm) {
    if (!dockStarted) {
        dockStarted = initDock(crm).catch(function (err) {
            dockStarted = null;
            throw err;
        });
    }
    return dockStarted;
}

async function initDock(crm) {
    const dock = await crm.cdn.loadApi('dock');
    const session = await crm.tokens.get('session');
    const options = {
        token: session.token,
        expires_at: session.expires_at,
        getToken: function () {
            return crm.tokens.refresh('session');
        },
        apiBase: crm.widgetApiBase,
        phoneApiBase: crm.widgetApiBase
    };
    const from = getBusinessNumber();
    if (from) {
        options.from = from;
    }

    // The Dock shows its Campaigns pane only when it gets a campaigns token.
    // Its init() fails as a whole if that token cannot be had, so the token is
    // fetched first and simply left out when it is unavailable.
    if (crm.tokens.supports('campaigns')) {
        try {
            const campaigns = await crm.tokens.get('campaigns');
            options.campaignsToken = campaigns.token;
            options.getCampaignsToken = function () {
                return crm.tokens.refresh('campaigns');
            };
        } catch {
            // No campaigns pane. The Campaigns page explains why.
        }
    }

    await dock.init(options);
    dock.addCallStartedListener(function (detail) {
        crm.activity.add(fromDock('callStarted', detail));
    });
    dock.addCallEndedListener(function (detail) {
        crm.activity.add(fromDock('callEnded', detail));
    });
    dock.addMessageSentListener(function (detail) {
        crm.activity.add(fromDock('messageSent', detail));
    });
    return dock;
}
