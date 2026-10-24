/**
 * Small helpers shared by every route: build a JSON `Response`, read a request
 * body with a size cap, and work out the caller's IP address.
 *
 * Where it sits: every handler in the web-standard core takes a web `Request`
 * and returns a web `Response`, so these helpers use only `Request`,
 * `Response`, `Headers` and `ReadableStream`. That is what lets the same
 * handlers run behind Express today and behind Hono, Next.js or Netlify
 * Functions later.
 *
 * CONTRACT.md: "Error envelope" (the 1 MB body cap), "Configuration"
 * (`DC_TRUST_PROXY`).
 * What a customer changes: nothing; call these from your own routes.
 */

import { HttpError } from './errors.js';

/** The largest request body any route accepts: 1 MB, enough for a webhook or a token request and far too small to exhaust memory. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Builds a JSON response.
 *
 * @param {number} status HTTP status code.
 * @param {unknown} body Anything `JSON.stringify` accepts.
 * @param {Record<string, string>} [headers] Extra response headers.
 * @returns {Response} A response with `Content-Type: application/json`.
 */
export function jsonResponse(status, body, headers = {}) {
    const out = new Headers(headers);
    out.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status, headers: out });
}

/**
 * Builds a plain-text response.
 *
 * @param {number} status HTTP status code.
 * @param {string} text The body.
 * @returns {Response} A response with `Content-Type: text/plain`.
 */
export function textResponse(status, text) {
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * Reads the whole request body, refusing anything over `limit` bytes.
 *
 * A declared `Content-Length` over the limit is refused before a byte is read.
 * A body that lies about its length, or has none (chunked), is counted as it
 * arrives and the read stops the moment the limit is crossed.
 *
 * @param {Request} request The incoming request.
 * @param {number} [limit] Largest accepted body in bytes.
 * @returns {Promise<Buffer>} The body bytes; empty when the request has none.
 * @throws {HttpError} 413 `payload_too_large` when the body is over the limit.
 */
export async function readBody(request, limit = MAX_BODY_BYTES) {
    const tooLarge = () => new HttpError(413, 'payload_too_large', 'Request body is larger than 1 MB.');
    const declared = Number.parseInt(request.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > limit) {
        throw tooLarge();
    }
    if (!request.body) {
        return Buffer.alloc(0);
    }

    const chunks = [];
    let total = 0;
    const reader = request.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => {});
            throw tooLarge();
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/**
 * Reads a JSON request body the way Express's `express.json()` did, so the
 * contract did not change when the core stopped using Express.
 *
 * Only `application/json` bodies are read (anything else yields `undefined`),
 * an empty body counts as `{}`, and only an object or an array is accepted at
 * the top level.
 *
 * @param {Request} request The incoming request.
 * @param {number} [limit] Largest accepted body in bytes.
 * @returns {Promise<unknown>} The parsed value, `{}` for an empty body, or
 *   `undefined` when the content type is not JSON.
 * @throws {HttpError} 400 `invalid_json`; 413 `payload_too_large`.
 */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
        return undefined;
    }
    const text = (await readBody(request, limit)).toString('utf8').trim();
    if (text === '') {
        return {};
    }
    // Strict, like body-parser: a bare string, number or null is not a body.
    if (text[0] !== '{' && text[0] !== '[') {
        throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
    }
}

/**
 * The address of the client that made the request.
 *
 * `trustProxy` is the number of reverse proxies in front of this server
 * (`DC_TRUST_PROXY`). With 0, only the TCP peer is believed, because any
 * client can send an `X-Forwarded-For` header. With N, the entry N hops from
 * the right of `X-Forwarded-For` is the client: each trusted proxy appends the
 * address it received the request from, so the rightmost N entries were added
 * by infrastructure you run.
 *
 * @param {Headers} headers The request headers.
 * @param {string|null|undefined} remoteAddress The TCP peer address, when the host provides it.
 * @param {number} trustProxy Number of trusted proxy hops.
 * @returns {string} The client address, or `unknown` when nothing is known.
 */
export function clientIp(headers, remoteAddress, trustProxy) {
    const peer = remoteAddress || 'unknown';
    if (!trustProxy || trustProxy < 1) {
        return peer;
    }
    const forwarded = (headers.get('x-forwarded-for') || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    const chain = forwarded.concat(peer === 'unknown' ? [] : [peer]);
    if (chain.length === 0) {
        return peer;
    }
    return chain[Math.max(0, chain.length - 1 - trustProxy)];
}
