/**
 * The error envelope: every error leaves this server as
 * `{ error: { code, message, request_id } }`, whatever went wrong and
 * whichever route.
 *
 * Where it sits: route handlers throw HttpError; the core's catch-all calls
 * toErrorResponse() to turn it into the envelope. fromUpstream() maps what Drop
 * Cowboy answered, without ever echoing its raw body.
 *
 * CONTRACT.md: "Error envelope", "Passing through Drop Cowboy errors".
 * What a customer changes: nothing; throw HttpError from your own routes.
 */

import { currentRequestId } from './request-context.js';

const STATUS_CODES = {
    400: 'bad-request',
    402: 'payment-required',
    403: 'forbidden',
    404: 'not-found',
    409: 'conflict',
    422: 'unprocessable-entity',
    429: 'too-many-requests'
};

const MAX_MESSAGE_LENGTH = 300;

/**
 * An error with the HTTP status, stable code and safe message the envelope needs.
 */
export class HttpError extends Error {
    /**
     * Creates the error.
     *
     * @param {number} status HTTP status to answer with.
     * @param {string} code Stable machine-readable code, such as `invalid_purpose`.
     * @param {string} message Plain-language message a user can read. Never put a secret in it.
     * @param {Record<string, string>} [headers] Extra response headers, such as `Retry-After`.
     */
    constructor(status, code, message, headers = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.headers = headers;
    }
}

/**
 * Builds the envelope as a response.
 *
 * @param {number} status HTTP status.
 * @param {string} code Stable error code.
 * @param {string} message Human-readable message.
 * @param {Record<string, string>} [headers] Extra headers, such as `Retry-After`.
 * @returns {Response} A JSON response whose body is `{ error: { code, message } }`.
 */
export function errorResponse(status, code, message, headers = {}) {
    const out = new Headers(headers);
    out.set('content-type', 'application/json; charset=utf-8');
    const error = { code, message };
    // Inside a request the id is always known; unit tests that build an envelope directly have none.
    const requestId = currentRequestId();
    if (requestId) error.request_id = requestId;
    return new Response(JSON.stringify({ error }), { status, headers: out });
}

/**
 * Maps a Drop Cowboy error response to the envelope. Only the code, a short
 * message and Retry-After are kept; the raw upstream body is never echoed,
 * because it could carry anything.
 *
 * @param {number} status The HTTP status Drop Cowboy answered with.
 * @param {unknown} body The parsed JSON body, or null when it was not JSON.
 * @param {Headers} [headers] The upstream response headers, read for Retry-After.
 * @returns {HttpError} The error to throw: a 401 becomes 502 `upstream_auth_failed`,
 *   other 4xx pass through with their code, everything else is 502 `upstream_error`.
 */
export function fromUpstream(status, body, headers) {
    if (status === 401) {
        return new HttpError(502, 'upstream_auth_failed',
            'Drop Cowboy rejected this server\'s API key. Check DROPCOWBOY_API_KEY and DROPCOWBOY_API_SECRET.');
    }
    if (status < 400 || status >= 500) {
        return new HttpError(502, 'upstream_error', 'Drop Cowboy could not complete the request. Try again shortly.');
    }

    const extra = {};
    const retryAfter = headers && headers.get('retry-after');
    if (status === 429 && retryAfter) {
        extra['Retry-After'] = retryAfter;
    }
    return new HttpError(status, upstreamCode(status, body), upstreamMessage(status, body), extra);
}

/**
 * Picks the most specific error code out of the shapes Drop Cowboy uses
 * (`detail.code`, `details.code`, `code`, `error`, the tail of `type`).
 *
 * @param {number} status The upstream status, used for a generic fallback code.
 * @param {unknown} body The parsed upstream body.
 * @returns {string} A stable code, never empty.
 */
export function upstreamCode(status, body) {
    const b = isObject(body) ? body : {};
    const candidates = [
        isObject(b.detail) ? b.detail.code : null,
        isObject(b.details) ? b.details.code : null,
        b.code,
        b.error,
        typeof b.type === 'string' ? b.type.split('/').pop() : null
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') {
            return candidate.trim();
        }
    }
    return STATUS_CODES[status] || 'bad-request';
}

function upstreamMessage(status, body) {
    const b = isObject(body) ? body : {};
    const candidates = [b.detail, b.message, b.title];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') {
            return candidate.trim().slice(0, MAX_MESSAGE_LENGTH);
        }
    }
    return 'Drop Cowboy refused the request (' + status + ').';
}

/**
 * Answers 404 `not_found` in the envelope for any unmatched route.
 *
 * @param {{ method: string, path: string }} ctx The request context.
 * @returns {Response} The 404 envelope.
 */
export function notFound(ctx) {
    return errorResponse(404, 'not_found', 'No route matches ' + ctx.method + ' ' + ctx.path + '.');
}

/**
 * Turns anything a handler threw into the envelope: an HttpError becomes its
 * own status and code, and anything else becomes 500 `internal_error`, logged
 * with a message that reveals nothing.
 *
 * @param {unknown} err What the handler threw.
 * @param {{ method: string, path: string, requestId?: string, hooks?: object }} ctx The request context.
 * @param {{ error: Function }} log The redacting logger.
 * @returns {Promise<Response>} The envelope response.
 */
export async function toErrorResponse(err, ctx, log) {
    if (err instanceof HttpError) {
        return errorResponse(err.status, err.code, err.message, err.headers);
    }
    await log.error('Unhandled error on', ctx.method, ctx.path + ':', err);
    if (ctx.hooks) {
        await ctx.hooks.onError({
            request_id: ctx.requestId, method: ctx.method, path: ctx.path, message: err && err.message ? err.message : 'unknown error'
        });
    }
    return errorResponse(500, 'internal_error', 'Something went wrong on this server.');
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
