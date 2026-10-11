// One place that turns every error the starter can meet into plain language.
//
// Errors arrive in three shapes, and readError() accepts all of them:
//   the starter server:      { "error": { "code": "login_expired", "message": "..." } }
//   Drop Cowboy public API: { "type": ".../errors/payment-required", "title", "status", "detail": "..." }
//   Drop Cowboy embed API:  { "message": "...", "detail": { "code": "consent_required", "reason": "opted_out" } }
// Codes come in snake_case or kebab-case (payment-required); normalizeCode() makes them one.

/**
 * @typedef {object} Guidance
 * @property {string} code     Normalized error code, e.g. "byoc_required".
 * @property {string} title    One short line for a heading.
 * @property {string} message  What happened and what to do, in plain language.
 * @property {{ href: string, label: string } | null} link  Where to fix it, if anywhere.
 * @property {'sign_in' | null} action  An action the app can offer as a button.
 */

export class AppError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{ status?: number | null, reason?: string | null, retryAfter?: string | null }} [extra]
     */
    constructor(code, message, extra) {
        super(message);
        this.name = 'AppError';
        this.code = normalizeCode(code);
        this.status = (extra && extra.status) || null;
        this.reason = (extra && extra.reason) || null;
        this.retryAfter = (extra && extra.retryAfter) || null;
    }
}

const SETUP = '/setup';

const STATUS_CODES = {
    400: 'bad_request',
    401: 'unauthorized',
    402: 'payment_required',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    422: 'unprocessable_entity',
    429: 'too_many_requests'
};

// Why Drop Cowboy refused a text or call for consent (detail.reason).
const CONSENT_REASONS = {
    no_granted_consent: 'Drop Cowboy has no granted consent on file for this contact and number.',
    phone_mismatch: 'This number is not one of the contact\'s numbers, so their recorded consent does not cover it.',
    opted_out: 'This contact opted out (replied STOP). They cannot be texted until they opt back in.',
    contact_dnc: 'This contact is on your Do Not Call list.',
    contact_not_found: 'Drop Cowboy could not find that contact, so there is no recorded consent to use.',
    consent_record_invalid: 'The consent on file no longer covers this number or channel.'
};

const CONSENT_FIX = 'Record consent for this contact first, or ask a team admin to turn on '
    + '"Use existing contact consent" in Building Blocks settings so consent already in Drop Cowboy counts.';

const CONSENT_LINK = { href: SETUP + '#contact_consent', label: 'Setup: contact consent' };

/** @type {Record<string, { title: string, message: string, link?: { href: string, label: string }, action?: 'sign_in' }>} */
const GUIDANCE = {
    login_required: {
        title: 'Sign in to continue',
        message: 'This starter is in login mode. Sign in with your Drop Cowboy account to get a session.',
        action: 'sign_in'
    },
    login_expired: {
        title: 'Your sign-in expired',
        message: 'Your Drop Cowboy sign-in is no longer valid. Sign in again to keep working.',
        action: 'sign_in'
    },
    login_not_configured: {
        title: 'Sign-in is not set up yet',
        message: 'Login mode needs the public sign-in client id (AUTH0_CLIENT_ID), and that client does not exist yet. '
            + 'Until it does, run the starter with DC_AUTH_MODE=server and your API key in .env.',
        link: { href: SETUP, label: 'Open setup' }
    },
    login_failed: {
        title: 'Sign-in did not finish',
        message: 'The sign-in response did not match the request this page started. Try signing in again.',
        action: 'sign_in'
    },
    session_not_found: {
        title: 'No development session yet',
        message: 'mcp-session mode reads .dropcowboy/session.json. Ask your AI agent to call mint_embed_token with the '
            + 'session scopes and write { token, expires_at, site_id } to that file, then reload.',
        link: { href: SETUP, label: 'Open setup' }
    },
    session_expired: {
        title: 'The development session expired',
        message: 'The token in .dropcowboy/session.json has expired. Ask your AI agent to mint a new one and rewrite the file.',
        link: { href: SETUP, label: 'Open setup' }
    },
    session_invalid: {
        title: 'The development session file is unreadable',
        message: '.dropcowboy/session.json must be JSON with a string token and an epoch-millisecond expires_at.',
        link: { href: SETUP, label: 'Open setup' }
    },
    purpose_unavailable: {
        title: 'Not available in this mode',
        message: 'mcp-session mode only hands the browser the session token (dialer and contacts). '
            + 'Campaigns and Phone need their own tokens: run the starter in server or login mode.',
        link: { href: SETUP, label: 'Open setup' }
    },
    payment_required: {
        title: 'Add funds to continue',
        message: 'Your plan allotment and prepaid balance are both used up. Add funds in the Drop Cowboy dashboard.',
        link: { href: SETUP + '#funds', label: 'Setup: funds' }
    },
    insufficient_balance: {
        title: 'Add funds to continue',
        message: 'Your plan allotment and prepaid balance are both used up, so calling and texting are unavailable. '
            + 'Add funds in the Drop Cowboy dashboard. Contacts and the pipeline keep working.',
        link: { href: SETUP + '#funds', label: 'Setup: funds' }
    },
    byoc_required: {
        title: 'Connect your carrier',
        message: 'Calling and texting run on your own carrier account. Connect one (BYOC) in Drop Cowboy, then reload. '
            + 'Contacts and the pipeline work without one.',
        link: { href: SETUP + '#connect_byoc', label: 'Setup: carrier' }
    },
    invalid_site_id: {
        title: 'The site id is not a UUID',
        message: 'Set DROPCOWBOY_SITE_ID to one UUID for this app, for example from crypto.randomUUID(), and restart the server.',
        link: { href: SETUP + '#site_id', label: 'Setup: site id' }
    },
    site_token_not_allowed: {
        title: 'A site token cannot mint tokens',
        message: 'Minting needs your API key on the server. Check how the server authenticates to Drop Cowboy.'
    },
    consent_required: {
        title: 'Consent needed',
        message: 'This contact needs recorded consent before you can text or call them. ' + CONSENT_FIX,
        link: CONSENT_LINK
    },
    consent_invalid: {
        title: 'Consent not valid',
        message: 'The consent sent with this request does not cover this contact and number. ' + CONSENT_FIX,
        link: CONSENT_LINK
    },
    insufficient_scope: {
        title: 'Missing permission',
        message: 'The token for this page does not carry the permission this action needs. '
            + 'Campaigns are read-only here: start and pause them in Drop Cowboy.'
    },
    forbidden: {
        title: 'Not allowed',
        message: 'Drop Cowboy refused this request for this token.'
    },
    unauthorized: {
        title: 'Session expired',
        message: 'The session token was rejected. The page asks the server for a new one; reload if this keeps happening.'
    },
    upstream_auth_failed: {
        title: 'The server\'s API key was refused',
        message: 'Drop Cowboy rejected the API key the starter server uses. Check DROPCOWBOY_API_KEY and DROPCOWBOY_API_SECRET in .env. '
            + 'The key needs the numbers:write scope.',
        link: { href: SETUP, label: 'Open setup' }
    },
    upstream_unreachable: {
        title: 'Drop Cowboy is unreachable',
        message: 'The starter server could not reach Drop Cowboy. Check your network and DROPCOWBOY_API_BASE.'
    },
    upstream_timeout: {
        title: 'Drop Cowboy is slow to answer',
        message: 'Drop Cowboy did not answer in time. Try again in a moment.'
    },
    upstream_error: {
        title: 'Drop Cowboy had a problem',
        message: 'Drop Cowboy answered with an error. Try again in a moment.'
    },
    too_many_requests: {
        title: 'Too many requests',
        message: 'Slow down for a moment, then try again.'
    },
    not_found: {
        title: 'Not found',
        message: 'That record does not exist, was deleted, or is not visible to this token.'
    },
    no_updatable_fields: {
        title: 'Nothing to save',
        message: 'Change at least one field before saving.'
    },
    invalid_phone: {
        title: 'Phone number not recognized',
        message: 'Enter the number in international format, for example +15125550142.'
    },
    contact_rejected: {
        title: 'Contact not saved',
        message: 'Drop Cowboy rejected this contact. Every contact needs a phone number or an email.'
    },
    update_not_saved: {
        title: 'The change did not stick',
        message: 'Drop Cowboy accepted the update, but reading the contact back shows the old values. Nothing was changed.'
    },
    business_number_missing: {
        title: 'Set a business number',
        message: 'Texts and replies are sent from one of your business numbers. Add it on the setup page.',
        link: { href: SETUP + '#business_number', label: 'Setup: business number' }
    },
    cdn_unavailable: {
        title: 'Widgets could not load',
        message: 'The Building Blocks scripts did not load from the CDN. Check the CDN version on the setup page and your network.',
        link: { href: SETUP, label: 'Open setup' }
    },
    invalid_cdn_version: {
        title: 'The CDN version is not a release number',
        message: 'DC_CDN_VERSION must be a release such as 3.33.0. Scripts are pinned with integrity hashes, so "latest" cannot be used.',
        link: { href: SETUP, label: 'Open setup' }
    },
    network_error: {
        title: 'Request did not reach its server',
        message: 'The browser could not complete the request. If the console shows a CORS error, Drop Cowboy has not allowed '
            + 'this origin yet; otherwise check your network.'
    }
};

/** Lowercase snake_case, so "payment-required" and "payment_required" match. */
export function normalizeCode(code) {
    return String(code || '').trim().toLowerCase().replace(/-/g, '_');
}

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function lastPathSegment(url) {
    const parts = text(url).split('/');
    return parts[parts.length - 1] || '';
}

/**
 * Builds an AppError from an HTTP status and a parsed JSON body of any of the
 * three shapes above.
 * @param {number} status
 * @param {unknown} body
 * @param {{ retryAfter?: string | null }} [extra]
 */
export function readError(status, body, extra) {
    const b = body && typeof body === 'object' ? body : {};
    const retryAfter = (extra && extra.retryAfter) || null;

    if (b.error && typeof b.error === 'object') {
        return new AppError(b.error.code || STATUS_CODES[status] || 'request_failed', text(b.error.message), { status, retryAfter });
    }

    const detail = b.detail;
    const detailObject = detail && typeof detail === 'object' ? detail : null;
    const code = (detailObject && text(detailObject.code))
        || (b.details && text(b.details.code))
        || text(b.code)
        || text(b.error)
        || lastPathSegment(b.type)
        || STATUS_CODES[status]
        || 'request_failed';
    const message = text(typeof detail === 'string' ? detail : '')
        || text(b.message)
        || text(b.title)
        || text(b.error_description);
    const reason = detailObject ? text(detailObject.reason) : '';
    return new AppError(code, message, { status, reason, retryAfter });
}

/** Reads a failed fetch Response into an AppError. Never throws. */
export async function errorFromResponse(response) {
    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    const retryAfter = response.headers && response.headers.get ? response.headers.get('retry-after') : null;
    return readError(response.status, body, { retryAfter });
}

/** fetch() itself rejects on DNS, offline and CORS failures. */
export function networkError() {
    return new AppError('network_error', 'The request did not reach its server.');
}

/**
 * Plain-language guidance for any error: an AppError, a widget dc-error
 * detail ({ code, message, reason }), or anything thrown.
 * @param {unknown} err
 * @returns {Guidance}
 */
export function explainError(err) {
    const e = err && typeof err === 'object' ? err : {};
    const code = normalizeCode(e.code) || (e.status && STATUS_CODES[e.status]) || 'request_failed';
    const known = GUIDANCE[code];
    if (code === 'consent_required') {
        return guidance(code, known.title, consentMessage(e.reason), CONSENT_LINK, null);
    }
    if (known) {
        const message = code === 'too_many_requests' && e.retryAfter
            ? known.message + ' Retry after ' + e.retryAfter + ' seconds.'
            : known.message;
        return guidance(code, known.title, message, known.link || null, known.action || null);
    }
    const fallback = text(e.message) || (typeof err === 'string' ? err : '') || 'Something went wrong. Try again.';
    return guidance(code, 'Something went wrong', fallback, null, null);
}

// The session token is refused without a carrier or a balance, so the app
// banner explains these once, on every page. What fixes each one:
const BANNER_FIXES = {
    byoc_required: 'you connect your carrier',
    insufficient_balance: 'you add funds'
};

/**
 * explainError() for a notice inside a page, below the app banner. A refusal
 * the banner already explains gets one short line pointing at it, so the page
 * does not show the same notice twice.
 * @param {unknown} err
 * @returns {Guidance}
 */
export function explainPageError(err) {
    const g = explainError(err);
    const fix = BANNER_FIXES[g.code];
    if (!fix) {
        return g;
    }
    return guidance(g.code, 'Calling and texting are off',
        'This needs calling and texting, which stay off until ' + fix + '. The notice at the top of the page says how.',
        g.link, g.action);
}

function guidance(code, title, message, link, action) {
    return { code, title, message, link, action };
}

/** Explains a consent_required refusal from its detail.reason. */
export function consentMessage(reason) {
    const lead = 'This contact needs recorded consent before you can text or call them.';
    const why = reason ? CONSENT_REASONS[reason] : '';
    if (reason === 'opted_out' || reason === 'contact_dnc') {
        return lead + ' ' + why;
    }
    return why ? lead + ' ' + why + ' ' + CONSENT_FIX : lead + ' ' + CONSENT_FIX;
}
