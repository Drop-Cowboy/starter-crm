/**
 * Your webhook handlers: code that runs once for each event the server receives.
 *
 * Where it sits: the processor (processor.js) calls `runHandlers()` for an event
 * after it is recorded and queued, and before it is marked processed and sent to
 * the browser's event stream. Set `DC_WEBHOOK_HANDLERS` to a file that exports
 * `handlers`, a map from event name to function:
 *
 * ```js
 * export const handlers = {
 *     'contact.msg.received': async (event, { eventId, attempt, signal, log }) => { ... },
 *     '*': async (event, ctx) => { ... }   // every event
 * };
 * ```
 *
 * Delivery is at-least-once: a handler can run more than once for the same event
 * (a retry after a crash, a replay), so it must be idempotent. Use `eventId` as the key
 * for whatever it writes. A handler that throws is retried with backoff up to
 * `DC_WEBHOOK_MAX_ATTEMPTS`, then the event is marked `failed` and
 * `npm run webhooks:replay -- <event_id>` runs it again.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (handlers).
 * What a customer changes: this is the file you point at; the loader itself stays as it is.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads the handlers file named by `DC_WEBHOOK_HANDLERS`.
 *
 * @param {{ events: { handlersPath: string|null }, root: string }} config The loaded config.
 * @returns {Promise<{ handlers: Record<string, Function>, problem: string|null }>} The handler map (empty when none is
 *   configured), or a description of what is wrong with the file.
 */
export async function loadHandlers(config) {
    if (!config.events.handlersPath) return { handlers: {}, problem: null };
    const file = path.resolve(config.root, config.events.handlersPath);
    let loaded;
    try {
        // The handlers file is the customer's own, named in the environment, so its path is only known at run time.
        loaded = await import(pathToFileURL(file).href);
    } catch (err) {
        return { handlers: {}, problem: 'could not be loaded: ' + (err && err.message ? err.message : 'unknown error') };
    }
    const map = loaded.handlers;
    if (!map || typeof map !== 'object') return { handlers: {}, problem: 'must export `handlers`, an object mapping event names to functions' };
    for (const [key, fn] of Object.entries(map)) {
        if (typeof fn !== 'function') return { handlers: {}, problem: 'handler "' + key + '" is not a function' };
    }
    return { handlers: map, problem: null };
}

/**
 * Runs every handler that matches an event, one after another, awaiting each.
 *
 * @param {Record<string, Function>} handlers The handler map from loadHandlers().
 * @param {object} event The event (`event_id`, `event`, `data`, and so on).
 * @param {{ eventId: string, attempt: number, signal: AbortSignal, log: object }} ctx What each handler receives after the event.
 * @returns {Promise<void>} Resolves when all have finished.
 * @throws {Error} The first handler's error; later handlers do not run.
 */
export async function runHandlers(handlers, event, ctx) {
    const names = [];
    if (typeof event.event === 'string' && Object.hasOwn(handlers, event.event)) names.push(event.event);
    if (Object.hasOwn(handlers, '*')) names.push('*');
    for (const name of names) {
        await handlers[name](event, ctx);
    }
}
