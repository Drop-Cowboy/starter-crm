import { errorFromResponse, networkError } from './errors.js';

// Calls to the Starter CRM server (see server/CONTRACT.md). Paths are
// same-origin, such as /api/config. Errors come back in the server's
// { error: { code, message } } envelope and are thrown as AppError.
//
// Who the user is, to your own server: with the passcode identity the browser
// sends its session cookie by itself. With the oidc identity (or your own
// bearer-token identity) the page must add an Authorization header, and
// setAuthHeaderProvider() is where your app tells this file how to get one.

/** @type {(() => Record<string, string> | null | Promise<Record<string, string> | null>) | null} */
let authHeaderProvider = null;

/**
 * Registers how to get the identity header for every call to this server, for
 * example `() => ({ Authorization: 'Bearer ' + await getAccessToken() })`.
 * Pass null to remove it. A header a caller passes to callServer() itself wins.
 *
 * @param {(() => Record<string, string> | null | Promise<Record<string, string> | null>) | null} provider
 * @returns {void}
 */
export function setAuthHeaderProvider(provider) {
    authHeaderProvider = typeof provider === 'function' ? provider : null;
}

/**
 * Whether the page registered an identity header, so a stream that cannot send
 * headers by itself (EventSource) knows to use the fetch-based reader.
 *
 * @returns {boolean} True after setAuthHeaderProvider() was given a function.
 */
export function hasAuthHeaderProvider() {
    return authHeaderProvider !== null;
}

/**
 * The identity header to send now: whatever the provider returns, or an empty
 * object when none is registered. Never throws for a missing token, so a page
 * that is not signed in still reaches the server and gets its 401.
 *
 * @returns {Promise<Record<string, string>>}
 */
export async function getAuthHeader() {
    if (!authHeaderProvider) {
        return {};
    }
    const found = await authHeaderProvider();
    return found && typeof found === 'object' ? found : {};
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, fetch?: typeof fetch }} [options]
 * @returns {Promise<any>}
 */
export async function callServer(path, options) {
    const opts = options || {};
    const fetchImpl = opts.fetch || globalThis.fetch;
    const headers = Object.assign({ Accept: 'application/json' }, await getAuthHeader(), opts.headers);
    const init = { method: opts.method || 'GET', headers, credentials: 'same-origin', cache: 'no-store' };
    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
    }

    let response;
    try {
        response = await fetchImpl(path, init);
    } catch {
        throw networkError();
    }
    if (!response.ok) {
        throw await errorFromResponse(response);
    }
    return response.json();
}
