import { HttpError } from './errors.js';

// ---------------------------------------------------------------------------
// REPLACE WITH YOUR AUTH
//
// requireUser() stands in for your CRM's own login. As shipped it lets every
// request through as the user in STARTER_CRM_USER_ID, which is only safe on your
// own machine. In your app, verify the session cookie or bearer token here,
// reject with 401 when there is none, and set req.user.id to your user's id.
//
// That id becomes the `sub` of every site token this server mints. Drop Cowboy
// uses it for attribution only; your users never need a Drop Cowboy login.
// ---------------------------------------------------------------------------
export function requireUser(config) {
    return function placeholderUser(req, res, next) {
        req.user = { id: config.starterUserId };
        next();
    };
}

// The characters an OAuth bearer token may contain (RFC 6750).
const BEARER = /^Bearer +([A-Za-z0-9._~+/-]+=*) *$/i;

// Login mode only: the browser signed in with Drop Cowboy and sends that
// access token as `Authorization: Bearer <token>`. This server does not check
// it. It forwards it to Drop Cowboy, which does, so a forged or expired token
// gets nothing. The token is never logged and never sent back.
export function requireLogin(req, res, next) {
    const match = BEARER.exec(req.get('authorization') || '');
    if (!match) {
        throw new HttpError(401, 'login_required',
            'Sign in with Drop Cowboy, then send the access token as Authorization: Bearer <token>.');
    }
    req.accessToken = match[1];
    next();
}
