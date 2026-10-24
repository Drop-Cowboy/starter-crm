/**
 * Who is calling: the two checks that guard the routes that mint tokens and
 * stream events.
 *
 * Where it sits: browser -> `/api/dropcowboy/token` -> requireUser() or
 * requireLogin() -> tokenRoute() -> Drop Cowboy. In server mode requireUser()
 * runs; in login mode requireLogin() runs.
 *
 * CONTRACT.md: "POST /api/dropcowboy/token" (Login mode), "GET /api/events".
 * What a customer changes: nothing here; choose or write an identity provider
 * (DC_IDENTITY) instead.
 */

import { HttpError } from './errors.js';
import { checkOrigin } from './security.js';

// ---------------------------------------------------------------------------
// WHO IS THE USER
//
// requireUser() asks the identity provider chosen by DC_IDENTITY who is calling.
// As shipped (`dev`) that is a fixed placeholder user, only safe on your own
// machine. For anything other people can reach, set DC_IDENTITY to `passcode`
// (one shared passcode), `oidc` (your existing sign-in) or the path of your own
// provider, a file of about ten lines; see docs/providers/identity.md.
//
// The id the identity returns becomes the `sub` of every site token this
// server mints. Drop Cowboy uses it for attribution only; your users never
// need a Drop Cowboy login.
// ---------------------------------------------------------------------------

/**
 * Builds the step that decides who the signed-in user is in server mode.
 *
 * Side effects: sets `ctx.user = { id, email?, name? }` on every request that
 * passes. A cookie-authenticated request that is not a GET or HEAD (a POST or a DELETE) must also pass the CSRF origin check.
 *
 * @param {{ authenticate: Function, cookieAuth?: boolean, challenge?: string }} identity The identity provider instance.
 * @returns {(ctx: object) => Promise<void>} A step that throws 401 `unauthenticated`
 *   when nobody is signed in.
 * @throws {HttpError} 401 `unauthenticated`, 403 `csrf_rejected`, or whatever the identity throws
 *   (401 `invalid_token`, 503 `identity_unavailable`).
 */
export function requireUser(identity) {
    return async function identifyUser(ctx) {
        const user = await identity.authenticate(ctx.request);
        if (!user) {
            throw new HttpError(401, 'unauthenticated', 'Sign in to use this app.',
                identity.challenge ? { 'www-authenticate': identity.challenge } : {});
        }
        // Every request that changes something: a cookie rides along on a form from any site, so POST and DELETE both need the check.
        if (identity.cookieAuth && ctx.method !== 'GET' && ctx.method !== 'HEAD') checkOrigin(ctx);
        ctx.user = user;
    };
}

// The characters an OAuth bearer token may contain (RFC 6750).
const BEARER = /^Bearer +([A-Za-z0-9._~+/-]+=*) *$/i;

/**
 * Login mode only: the browser signed in with Drop Cowboy and sends that
 * access token as `Authorization: Bearer <token>`. This server does not check
 * it. It forwards it to Drop Cowboy, which does, so a forged or expired token
 * gets nothing. The token is never logged and never sent back.
 *
 * Side effects: sets `ctx.accessToken` to the bearer value.
 *
 * @param {{ request: Request, accessToken?: string }} ctx The request context.
 * @returns {Promise<void>} Resolves when a well-formed bearer is present.
 * @throws {HttpError} 401 `login_required` when the header is missing or malformed.
 */
export async function requireLogin(ctx) {
    const match = BEARER.exec(ctx.request.headers.get('authorization') || '');
    if (!match) {
        throw new HttpError(401, 'login_required',
            'Sign in with Drop Cowboy, then send the access token as Authorization: Bearer <token>.');
    }
    ctx.accessToken = match[1];
}
