/**
 * The id of the request being handled, available anywhere below `handle()`.
 *
 * Where it sits: the core wraps each request in `runWithRequestId()`. Code
 * that builds an error envelope (`errors.js`) reads `currentRequestId()`
 * instead of every route having to thread the id through, so no error can be
 * written without one.
 *
 * CONTRACT.md: "Request ids".
 * What a customer changes: nothing; call `currentRequestId()` from your own
 * code when you want to tag your own log lines.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

const storage = new AsyncLocalStorage();

/**
 * A request id the client may send: 1 to 64 URL-safe characters. Anything
 * else could carry control characters or spoof a log line.
 */
const ACCEPTED_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Picks the id for a request: the client's own when it is acceptable, else a new UUID.
 *
 * @param {string|null|undefined} header The incoming `X-Request-Id` value.
 * @returns {string} The id to use.
 */
export function pickRequestId(header) {
    return typeof header === 'string' && ACCEPTED_ID.test(header) ? header : crypto.randomUUID();
}

/**
 * Runs `fn` with `requestId` as the current request id.
 *
 * @template T
 * @param {string} requestId The id of the request.
 * @param {() => Promise<T>} fn The work to run for that request.
 * @returns {Promise<T>} Whatever `fn` returns.
 */
export function runWithRequestId(requestId, fn) {
    return storage.run({ requestId }, fn);
}

/**
 * The id of the request being handled.
 *
 * @returns {string|null} The id, or null outside a request (boot, tests).
 */
export function currentRequestId() {
    const store = storage.getStore();
    return store ? store.requestId : null;
}
