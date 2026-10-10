import { HttpError } from './errors.js';
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

export const TOKEN_TTL_SECONDS = 900;

export function scopesForPurpose(purpose) {
    // Own keys only, so "constructor" or "__proto__" can't match.
    if (typeof purpose !== 'string' || !Object.hasOwn(PURPOSE_SCOPES, purpose)) {
        return null;
    }
    return [...PURPOSE_SCOPES[purpose]];
}

export function tokenRoute(config, fetchImpl) {
    return async function mintToken(req, res) {
        const body = req.body !== null && typeof req.body === 'object' ? req.body : {};
        const scope = scopesForPurpose(body.purpose);
        if (!scope) {
            throw new HttpError(400, 'invalid_purpose',
                'purpose must be one of: ' + Object.keys(PURPOSE_SCOPES).join(', '));
        }

        // Login mode sends no sub: Drop Cowboy knows the user from their
        // token, and a sub the browser chose would be a claim nobody checked.
        const result = await callDropCowboy(config, fetchImpl, {
            method: 'POST',
            path: '/phone/public/embed/token',
            accessToken: req.accessToken,
            body: req.accessToken
                ? { site_id: config.siteId, scope, ttl_seconds: TOKEN_TTL_SECONDS }
                : { site_id: config.siteId, sub: req.user.id, scope, ttl_seconds: TOKEN_TTL_SECONDS }
        });

        const data = result.data || {};
        if (typeof data.token !== 'string' || data.token === '' || typeof data.expires_at !== 'number') {
            throw new HttpError(502, 'upstream_error', 'Drop Cowboy sent a token response this server could not read.');
        }

        res.set('Cache-Control', 'no-store');
        res.json({ token: data.token, expires_at: data.expires_at });
    };
}
