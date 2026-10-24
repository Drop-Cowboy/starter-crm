import { AppError } from './errors.js';
import { callServer } from './server-api.js';

// Who the user is, as your own server sees it (`server` mode only).
//
// The server's identity provider decides how a user proves who they are:
//
//   dev        Nobody signs in; every request is one fixed user. Local only.
//   passcode   A shared passcode, exchanged for an HttpOnly session cookie.
//              This file signs in and out; the cookie never reaches JavaScript.
//   oidc       A bearer token from your sign-in provider. Your app registers it
//              with setAuthHeaderProvider() in server-api.js; this file only asks
//              the server whether that token is accepted.
//   custom     Your own provider. Same questions, same answers.
//
// GET /api/auth/session is how a page learns which one it is talking to. It
// never answers 401, so a signed-out page can draw a sign-in screen.

/**
 * @typedef {object} IdentitySession
 * @property {string} identity   `dev`, `passcode`, `oidc` or `custom`.
 * @property {boolean} signedIn
 * @property {{ id: string, email?: string, name?: string } | null} user
 */

/**
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {{
 *   session(): Promise<IdentitySession>,
 *   signInWithPasscode(passcode: string): Promise<IdentitySession>,
 *   signOut(): Promise<IdentitySession>,
 *   current(): IdentitySession
 * }}
 */
export function createIdentity(options) {
    const fetchImpl = options && options.fetch;

    /** What the page knows until the server is asked: signed in, as `dev`, which needs nothing. */
    let known = { identity: 'dev', signedIn: true, user: null };

    function remember(body) {
        known = {
            identity: typeof body.identity === 'string' ? body.identity : 'dev',
            signedIn: body.signed_in === true,
            user: body.user || null
        };
        return known;
    }

    return {
        /**
         * Asks the server who the user is.
         *
         * @returns {Promise<IdentitySession>} The answer; a server that predates the route counts as `dev`.
         */
        async session() {
            try {
                return remember(await callServer('/api/auth/session', { fetch: fetchImpl }));
            } catch (err) {
                if (err && err.code === 'not_found') {
                    known = { identity: 'dev', signedIn: true, user: null };
                    return known;
                }
                throw err;
            }
        },

        /**
         * Exchanges the passcode for a session cookie.
         *
         * @param {string} passcode What the person typed.
         * @returns {Promise<IdentitySession>} The signed-in session.
         * @throws {AppError} `invalid_passcode` for a wrong one, `rate_limited` after too many tries.
         */
        async signInWithPasscode(passcode) {
            if (typeof passcode !== 'string' || passcode === '') {
                throw new AppError('invalid_passcode', 'Enter the passcode.');
            }
            await callServer('/api/auth/passcode', { method: 'POST', body: { passcode }, fetch: fetchImpl });
            return this.session();
        },

        /**
         * Clears the session cookie.
         *
         * @returns {Promise<IdentitySession>} The signed-out session.
         */
        async signOut() {
            await callServer('/api/auth/signout', { method: 'POST', body: {}, fetch: fetchImpl });
            return this.session();
        },

        /** @returns {IdentitySession} The last answer the server gave. */
        current() {
            return known;
        }
    };
}

/**
 * What the sign-in screen says, for either front-end.
 *
 * @param {IdentitySession} session The server's answer to GET /api/auth/session.
 * @returns {{ form: boolean, title: string, message: string }} `form` is true when the page can sign the
 *   user in itself (the passcode); false when the sign-in happens elsewhere and this page only explains.
 */
export function signInScreen(session) {
    if (session.identity === 'passcode') {
        return {
            form: true,
            title: 'Sign in to Starter CRM',
            message: 'Enter the passcode for this app. It is the DC_PASSCODE the person who deployed it chose.'
        };
    }
    if (session.identity === 'oidc') {
        return {
            form: false,
            title: 'Sign in with your account',
            message: 'This server accepts sign-ins from your identity provider. The page needs to send that provider\'s '
                + 'token with each request: see CUSTOMIZE.md, "Identity recipes", for setAuthHeaderProvider().'
        };
    }
    return {
        form: false,
        title: 'Sign in to continue',
        message: 'This server uses its own sign-in (DC_IDENTITY=' + session.identity + '). Sign in the way your app does, then reload.'
    };
}
