/**
 * Token minting: turns a page's stated purpose into a short-lived Drop Cowboy
 * site token without ever letting the browser choose scopes.
 *
 * Where it sits: browser -> `POST /api/dropcowboy/token` -> tokenRoute() ->
 * Drop Cowboy `POST /phone/public/embed/token` -> `{ token, expires_at }`.
 *
 * CONTRACT.md: "POST /api/dropcowboy/token".
 * What a customer changes: PURPOSE_SCOPES, if a new page needs a new purpose.
 */

import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { jsonResponse, readJsonBody } from './http.js';
import { createTokenCache } from './token-cache.js';
import { callDropCowboy } from './upstream.js';

// The browser names what it needs a token for; the server alone decides which
// scopes that means. Never accept scopes from the browser: a page that could
// ask for `numbers:write` could rent phone numbers on your account.
//
// Ask for the least a page needs. Drop Cowboy only checks for a connected
// carrier and a balance when the scopes include calling (`dialer:webrtc` or
// `phone:hub`), so the contacts pages use `contacts` and keep working for a
// team that has neither.
export const PURPOSE_SCOPES = Object.freeze({
    session: Object.freeze(['dialer:webrtc', 'contacts']),
    contacts: Object.freeze(['contacts']),
    campaigns: Object.freeze(['campaigns']),
    phone: Object.freeze(['phone:hub'])
});

/** Mints per user per minute that may reach Drop Cowboy: well under its own limit, so one busy user cannot starve the rest. */
export const MINT_PER_USER_PER_MINUTE = 30;

/** Token lifetime asked of Drop Cowboy: 15 minutes, long enough for a page, short enough to limit a leak. */
export const TOKEN_TTL_SECONDS = 900;

/**
 * Looks up the scopes for a purpose.
 *
 * @param {unknown} purpose What the browser asked for.
 * @returns {string[] | null} A fresh copy of the scopes, or null when the purpose is unknown.
 */
export function scopesForPurpose(purpose) {
    // Own keys only, so "constructor" or "__proto__" can't match.
    if (typeof purpose !== 'string' || !Object.hasOwn(PURPOSE_SCOPES, purpose)) {
        return null;
    }
    return [...PURPOSE_SCOPES[purpose]];
}

/**
 * Builds the `POST /api/dropcowboy/token` handler.
 *
 * Side effects: one authenticated call to Drop Cowboy per request; the
 * response is marked `Cache-Control: no-store`.
 *
 * @param {object} config Validated config (site id, API base, timeout, mode).
 * @param {typeof fetch} fetchImpl The fetch to use, swapped in tests.
 * @returns {(ctx: object) => Promise<Response>} Async handler.
 * @throws {HttpError} 400 `invalid_purpose`; 400 `invalid_json`; 413 `payload_too_large`; 502 `upstream_error` when Drop
 *   Cowboy answers with something that is not a token; anything callDropCowboy() throws.
 */
export function tokenRoute(config, fetchImpl) {
    // Login mode never caches: the token is minted for whoever holds an access token.
    const cache = config.mode === 'server' && config.tokenCache ? createTokenCache() : null;

    return async function mintToken(ctx) {
        const parsed = await readJsonBody(ctx.request);
        const body = parsed !== null && typeof parsed === 'object' ? parsed : {};
        const scope = scopesForPurpose(body.purpose);
        if (!scope) {
            throw new HttpError(400, 'invalid_purpose',
                'purpose must be one of: ' + Object.keys(PURPOSE_SCOPES).join(', '));
        }

        const userId = ctx.user ? ctx.user.id : null;
        const cacheKey = cache ? userId + '|' + body.purpose : null;
        const hit = cache ? cache.get(cacheKey) : null;
        if (hit) {
            await ctx.hooks.onTokenMinted({
                request_id: ctx.requestId, user_id: userId, purpose: body.purpose, cached: true, expires_at: hit.expires_at
            });
            return jsonResponse(200, { token: hit.token, expires_at: hit.expires_at }, { 'cache-control': 'no-store' });
        }

        // Only a request that will reach Drop Cowboy uses up the per-user allowance. In login
        // mode the caller is identified by their access token, hashed so it is never a map key.
        const limitKey = ctx.accessToken ? crypto.createHash('sha256').update(ctx.accessToken).digest('hex') : userId;
        await ctx.limit('mint-user', limitKey, MINT_PER_USER_PER_MINUTE);

        // Login mode sends no sub: Drop Cowboy knows the user from their
        // token, and a sub the browser chose would be a claim nobody checked.
        const result = await callDropCowboy(config, fetchImpl, {
            method: 'POST',
            path: '/phone/public/embed/token',
            accessToken: ctx.accessToken,
            body: ctx.accessToken
                ? { site_id: config.siteId, scope, ttl_seconds: TOKEN_TTL_SECONDS }
                : { site_id: config.siteId, sub: ctx.user.id, scope, ttl_seconds: TOKEN_TTL_SECONDS }
        });

        const data = result.data || {};
        if (typeof data.token !== 'string' || data.token === '' || typeof data.expires_at !== 'number') {
            throw new HttpError(502, 'upstream_error', 'Drop Cowboy sent a token response this server could not read.');
        }

        if (cache) cache.set(cacheKey, { token: data.token, expires_at: data.expires_at });
        await ctx.hooks.onTokenMinted({
            request_id: ctx.requestId, user_id: userId, purpose: body.purpose, cached: false, expires_at: data.expires_at
        });
        return jsonResponse(200, { token: data.token, expires_at: data.expires_at }, { 'cache-control': 'no-store' });
    };
}
