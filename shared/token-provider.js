import { AppError } from './errors.js';
import { callServer } from './server-api.js';

// Where the browser gets site tokens. The browser names a purpose; the server
// alone decides the scopes, so a page can never ask for more than it needs.
//
//   session    ["dialer:webrtc", "contacts"]  The Dock: dialer, messenger, inbox and their contact panes
//   contacts   ["contacts"]                   Contacts REST, the contact card and the pipeline board
//   campaigns  ["campaigns"]                  The read-only campaign hub
//   phone      ["phone:hub"]                  Phone hub and number picker (can rent numbers)
//
// Drop Cowboy only checks for a connected carrier and a balance when a token
// can call (dialer:webrtc or phone:hub). The contacts pages use their own
// contacts token, so they work for a team that has set up neither yet.
//
// Three ways to get one, picked by /api/config auth_mode:
//   server       POST /api/dropcowboy/token { purpose }. The server mints with its API key.
//   login        The same route, with "Authorization: Bearer <Drop Cowboy access token>".
//   mcp-session  GET /__dev/session, a token your AI agent minted into a file. Dev only.
//                There is only that one token, so the contacts pages reuse it.

export const PURPOSES = ['session', 'contacts', 'campaigns', 'phone'];

const DEV_SESSION_PURPOSES = ['session', 'contacts'];

/**
 * @typedef {{ token: string, expires_at: number }} SiteToken
 * Widgets accept this object straight from getToken().
 */

/**
 * @param {{
 *   config: { auth_mode: string },
 *   login?: ReturnType<typeof import('./login.js').createLogin> | null,
 *   fetch?: typeof fetch
 * }} options
 */
export function createTokenProvider(options) {
    const mode = options.config.auth_mode;
    const login = options.login || null;
    const fetchImpl = options.fetch;

    function supports(purpose) {
        return mode === 'mcp-session' ? DEV_SESSION_PURPOSES.includes(purpose) : PURPOSES.includes(purpose);
    }

    /** Authorization header for server routes that need the signed-in user (login mode). */
    function authHeaders() {
        if (mode !== 'login') {
            return {};
        }
        if (!login || !login.isConfigured()) {
            throw new AppError('login_not_configured', 'AUTH0_CLIENT_ID is not set.');
        }
        const accessToken = login.accessToken();
        if (!accessToken) {
            throw new AppError('login_required', 'Sign in with Drop Cowboy first.');
        }
        return { Authorization: 'Bearer ' + accessToken };
    }

    async function mint(purpose) {
        try {
            return await callServer('/api/dropcowboy/token', {
                method: 'POST',
                body: { purpose },
                headers: authHeaders(),
                fetch: fetchImpl
            });
        } catch (err) {
            // The sign-in itself expired: forget it so the app offers "Sign in" again.
            if (err && err.code === 'login_expired' && login) {
                login.signOut();
            }
            throw err;
        }
    }

    async function readDevSession(purpose) {
        if (!DEV_SESSION_PURPOSES.includes(purpose)) {
            throw new AppError('purpose_unavailable', 'mcp-session mode only provides the session token.');
        }
        return callServer('/__dev/session', { fetch: fetchImpl });
    }

    /**
     * @param {string} purpose
     * @returns {Promise<SiteToken>}
     */
    async function fetchToken(purpose) {
        if (!PURPOSES.includes(purpose)) {
            throw new AppError('invalid_purpose', 'Unknown token purpose: ' + purpose);
        }
        const body = mode === 'mcp-session' ? await readDevSession(purpose) : await mint(purpose);
        return { token: body.token, expires_at: body.expires_at };
    }

    return { mode, supports, authHeaders, fetchToken };
}

const REUSE_MARGIN_MS = 60000;

/**
 * Remembers one token per purpose so pages and REST calls share it, and
 * makes concurrent requests for the same purpose share one mint.
 *
 * get()     returns the remembered token while it has more than a minute left.
 * refresh() always asks for a new one. Widgets' getToken uses this, because
 *           they call it exactly when they need a different token.
 *
 * @param {ReturnType<typeof createTokenProvider>} provider
 * @param {{ now?: () => number }} [options]
 */
export function createTokenStore(provider, options) {
    const now = (options && options.now) || Date.now;
    const tokens = {};
    const inflight = {};

    function refresh(purpose) {
        if (!inflight[purpose]) {
            inflight[purpose] = provider.fetchToken(purpose)
                .then(function (fresh) {
                    tokens[purpose] = fresh;
                    return fresh;
                })
                .finally(function () {
                    delete inflight[purpose];
                });
        }
        return inflight[purpose];
    }

    function get(purpose) {
        const known = tokens[purpose];
        if (known && known.expires_at - now() > REUSE_MARGIN_MS) {
            return Promise.resolve(known);
        }
        return refresh(purpose);
    }

    function forget() {
        const keys = Object.keys(tokens);
        for (let i = 0; i < keys.length; i++) {
            delete tokens[keys[i]];
        }
    }

    return { get, refresh, forget, supports: provider.supports };
}
