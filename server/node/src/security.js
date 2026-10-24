/**
 * Response security headers, CORS and the CSRF origin check.
 *
 * Where it sits: the core calls `applySecurityHeaders()` and `applyCors()` on
 * every response, `preflight()` for `OPTIONS`, and the passcode identity (and
 * any cookie-authenticated POST) calls `checkOrigin()`.
 *
 * CONTRACT.md: "Response headers", "CORS", "CSRF".
 * Env: DC_CSP, DC_CORS_ORIGINS, DC_PUBLIC_URL, DC_TRUST_PROXY, DC_ENV.
 * What a customer changes: the Content-Security-Policy below when adding another
 * third-party origin to the page.
 */

import { HttpError, errorResponse } from './errors.js';

/** HSTS lifetime: one year. No includeSubDomains, because the starter does not own your other subdomains. */
const HSTS = 'max-age=31536000';

/** Seconds a browser may cache a CORS preflight answer. */
const PREFLIGHT_MAX_AGE = '600';

/**
 * The Content-Security-Policy. Only public origins appear: Drop Cowboy's
 * Building Blocks and API hosts, plus the sign-in host in `login` mode.
 *
 * @param {object} config The loaded config.
 * @returns {string} The policy.
 */
export function contentSecurityPolicy(config) {
    const blocks = 'https://webforms.dropcowboy.com';
    const api = 'https://app-api-v2.dropcowboy.com';
    const connect = ["'self'", api, 'wss://app-api-v2.dropcowboy.com', 'https://api-v2.dropcowboy.com'];
    const frames = [blocks];
    if (config.mode === 'login') {
        const login = 'https://' + config.auth0.domain;
        connect.push(login);
        frames.push(login);
    }
    return [
        "default-src 'self'",
        "script-src 'self' " + blocks,
        // Inline styles: the Building Blocks set style attributes while they render.
        "style-src 'self' 'unsafe-inline' " + blocks,
        "img-src 'self' data: blob: " + blocks,
        "font-src 'self' data: " + blocks,
        'connect-src ' + connect.join(' '),
        'frame-src ' + frames.join(' '),
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');
}

/**
 * Sets the fixed security headers on a response.
 *
 * @param {Response} response The response to mark.
 * @param {object} config The loaded config.
 * @returns {void}
 */
export function applySecurityHeaders(response, config) {
    const set = (name, value) => response.headers.set(name, value);
    set('x-content-type-options', 'nosniff');
    set('referrer-policy', 'no-referrer');
    set('cross-origin-opener-policy', 'same-origin');
    // The dialer needs the microphone; nothing here needs the camera or location.
    set('permissions-policy', 'microphone=(self), camera=(), geolocation=()');
    // Browsers ignore frame-ancestors in a report-only policy, so say it twice.
    set('x-frame-options', 'DENY');
    if (config.csp === 'enforce') set('content-security-policy', contentSecurityPolicy(config));
    if (config.csp === 'report-only') set('content-security-policy-report-only', contentSecurityPolicy(config));
    if (config.env === 'production') set('strict-transport-security', HSTS);
}

/**
 * Adds CORS headers when the request's origin is on the allowlist.
 *
 * @param {Request} request The incoming request.
 * @param {Response} response The response to mark.
 * @param {object} config The loaded config.
 * @returns {void}
 */
export function applyCors(request, response, config) {
    const origin = request.headers.get('origin');
    if (!origin || !config.corsOrigins.includes(origin)) return;
    response.headers.set('access-control-allow-origin', origin);
    response.headers.append('vary', 'Origin');
    response.headers.set('access-control-expose-headers', 'X-Request-Id, Retry-After');
}

/**
 * Answers a CORS preflight.
 *
 * @param {object} ctx The request context.
 * @returns {Response|null} 204 for an allowed origin, 403 `cors_rejected` for any other,
 *   or null when this is not a preflight or CORS is off (the caller answers 404).
 */
export function preflight(ctx) {
    const { request, config } = ctx;
    if (config.corsOrigins.length === 0 || !request.headers.get('access-control-request-method')) return null;
    const origin = request.headers.get('origin');
    if (!origin || !config.corsOrigins.includes(origin)) {
        return errorResponse(403, 'cors_rejected', 'This origin is not allowed to call the API. Add it to DC_CORS_ORIGINS.');
    }
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'Authorization, Content-Type, Last-Event-ID, X-Request-Id',
            'access-control-max-age': PREFLIGHT_MAX_AGE
        }
    });
}

/**
 * The origins a cookie-authenticated request may come from.
 *
 * @param {object} ctx The request context.
 * @returns {string[]} Allowed origins: this server's own, plus `DC_CORS_ORIGINS`.
 */
function trustedOrigins(ctx) {
    const { config, request } = ctx;
    let own;
    if (config.publicUrl) {
        own = config.publicUrl;
    } else {
        const url = new URL(request.url);
        let protocol = url.protocol.replace(':', '');
        let host = url.host;
        // Only believe the proxy's headers when told how many proxies to trust.
        if (config.trustProxy > 0) {
            const forwardedProto = (request.headers.get('x-forwarded-proto') || '').split(',')[0].trim();
            const forwardedHost = (request.headers.get('x-forwarded-host') || '').split(',')[0].trim();
            if (forwardedProto) protocol = forwardedProto;
            if (forwardedHost) host = forwardedHost;
        }
        own = protocol + '://' + host;
    }
    return [own, ...config.corsOrigins];
}

/**
 * The CSRF check for a state-changing request that authenticates with a cookie.
 *
 * A browser attaches cookies to cross-site requests, so a hostile page could
 * make one on the user's behalf. The browser always says where such a request
 * came from, in `Origin` or `Sec-Fetch-Site`, and a cookie-less client (curl,
 * a server) is not at risk, so a request with neither header is refused too.
 *
 * @param {object} ctx The request context.
 * @returns {void}
 * @throws {HttpError} 403 `csrf_rejected`.
 */
export function checkOrigin(ctx) {
    const reject = () => new HttpError(403, 'csrf_rejected',
        'This request came from an origin this server does not trust. Open the app at its own address.');
    const origin = ctx.request.headers.get('origin');
    if (origin !== null) {
        if (!trustedOrigins(ctx).includes(origin)) throw reject();
        return;
    }
    const site = ctx.request.headers.get('sec-fetch-site');
    if (site === 'same-origin' || site === 'none') return;
    throw reject();
}
