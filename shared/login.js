import {
    buildAuthorizeUrl,
    codeChallengeFor,
    createCodeVerifier,
    exchangeCode,
    randomString,
    readCallback
} from './auth0-pkce.js';
import { AppError } from './errors.js';

// "Sign in with Drop Cowboy" for login mode.
//
// The access token lives in a variable in this module and nowhere else: not
// in localStorage, sessionStorage, a cookie, the URL or a log. A reload
// forgets it, and the user signs in again (Drop Cowboy remembers them, so it
// is usually one click). Only the PKCE verifier and state survive the
// redirect, in sessionStorage; neither is a token.

const PENDING_KEY = 'starter-crm.sign-in';

/**
 * @param {{
 *   auth0: { domain: string, client_id: string | null, audience: string },
 *   redirectUri: string,
 *   storage?: Storage,
 *   location?: { href: string, assign(url: string): void },
 *   history?: { replaceState(data: unknown, unused: string, url: string): void },
 *   fetch?: typeof fetch,
 *   now?: () => number
 * }} options
 */
export function createLogin(options) {
    const auth0 = options.auth0;
    const storage = options.storage || globalThis.sessionStorage;
    const location = options.location || globalThis.location;
    const history = options.history || globalThis.history;
    const now = options.now || Date.now;
    let accessToken = null;
    let expiresAt = 0;

    function isConfigured() {
        return !!(auth0 && auth0.client_id);
    }

    function requireConfigured() {
        if (!isConfigured()) {
            throw new AppError('login_not_configured', 'AUTH0_CLIENT_ID is not set.');
        }
    }

    /** Sends the browser to the Drop Cowboy sign-in page. */
    async function signIn(returnTo) {
        requireConfigured();
        const verifier = createCodeVerifier();
        const state = randomString(16);
        storage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, returnTo: returnTo || '/' }));
        location.assign(buildAuthorizeUrl({
            domain: auth0.domain,
            clientId: auth0.client_id,
            audience: auth0.audience,
            redirectUri: options.redirectUri,
            state,
            codeChallenge: await codeChallengeFor(verifier)
        }));
    }

    /**
     * Finishes a sign-in when the page loads with ?code=...&state=... .
     * Returns the path to show next, or null when this was not a callback.
     */
    async function handleCallback() {
        const callback = readCallback(location.href);
        if (!callback) {
            return null;
        }
        const pending = JSON.parse(storage.getItem(PENDING_KEY) || 'null');
        storage.removeItem(PENDING_KEY);
        const returnTo = (pending && pending.returnTo) || '/';
        // Take the one-time code out of the address bar and history right away.
        history.replaceState(null, '', returnTo);

        if ('error' in callback) {
            throw new AppError('login_failed', callback.description || callback.error);
        }
        if (!pending || pending.state !== callback.state) {
            throw new AppError('login_failed', 'The sign-in state did not match.');
        }
        requireConfigured();
        const result = await exchangeCode({
            domain: auth0.domain,
            clientId: auth0.client_id,
            code: callback.code,
            verifier: pending.verifier,
            redirectUri: options.redirectUri,
            fetch: options.fetch
        });
        accessToken = result.accessToken;
        expiresAt = result.expiresAt;
        return returnTo;
    }

    /** The access token, or null when signed out or past its expiry. */
    function currentAccessToken() {
        if (accessToken && now() >= expiresAt) {
            accessToken = null;
        }
        return accessToken;
    }

    function signOut() {
        accessToken = null;
        expiresAt = 0;
    }

    return {
        isConfigured,
        signIn,
        handleCallback,
        accessToken: currentAccessToken,
        isSignedIn: function () {
            return !!currentAccessToken();
        },
        signOut
    };
}
