/**
 * The event processor: what happens to an event after the webhook has recorded it.
 *
 * Where it sits: every webhook mode (store outbox, BullMQ, inline) ends up calling
 * `process(eventId)`. It reads the event from the store, runs your handlers and your modules' event handlers, finishes
 * the event (`processed`, or `failed` once `DC_WEBHOOK_MAX_ATTEMPTS` runs have
 * failed), and publishes it to the fan-out so browsers see it. One function does all of
 * that so every mode behaves the same way: the modes differ only in how an event id
 * reaches here.
 *
 * Because delivery is at-least-once, `process()` is safe to call again for an event
 * that has already finished: it does nothing and says so.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
 * What a customer changes: nothing; write handlers instead (handlers.js).
 */

import { runHandlers } from './handlers.js';
import { publicEvent } from './providers/store/common.js';

/** First retry delay; each failure doubles it. */
const BACKOFF_BASE_MS = 1000;

/** The longest wait between two attempts. */
const BACKOFF_CAP_MS = 5 * 60 * 1000;

/**
 * How long to wait before the next attempt.
 *
 * @param {number} failures How many attempts have failed so far (at least 1).
 * @returns {number} Milliseconds: 1 s, 2 s, 4 s, and so on up to five minutes.
 */
export function backoffMs(failures) {
    return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}

/**
 * Creates the processor.
 *
 * @param {{ config: object, store: object, fanout: object, handlers: Record<string, Function>, log: object,
 *   onEvent?: ((event: object, info: object) => Promise<void>)|null, now?: () => number }} deps What it works with:
 *   `onEvent` is the modules' event runner (modules.js), called after your handlers; `now` is replaced in tests.
 * @returns {{ process: (eventId: string, options?: { budgetMs?: number }) => Promise<{ outcome: string, error?: string }> }}
 *   The processor.
 */
export function createProcessor({ config, store, fanout, handlers, log, onEvent = null, now = Date.now }) {
    const maxAttempts = config.events.maxAttempts;

    /**
     * Sends a finished event to the browsers, without letting a fan-out outage undo the processing.
     *
     * @param {string} eventId The finished event.
     * @returns {Promise<void>}
     */
    async function publish(eventId) {
        try {
            const row = await store.get(eventId);
            if (row) await fanout.publish(publicEvent(row));
        } catch (err) {
            // The event is safely stored; a browser that missed the push replays it from the store on reconnect.
            await log.warn('Could not publish event ' + eventId + ' to event streams:', err.message);
        }
    }

    return {
        /**
         * Runs the handlers for one event and finishes it.
         *
         * @param {string} eventId The event to process.
         * @param {{ budgetMs?: number }} [options] `budgetMs` aborts the handlers' signal after that long (inline mode);
         *   the handlers are still awaited to completion.
         * @returns {Promise<{ outcome: 'processed'|'retry'|'failed'|'skipped'|'missing', error?: string }>} What happened:
         *   `retry` means a handler failed and another attempt is scheduled, `failed` means the attempts are used up,
         *   `skipped` means the event had already finished, `missing` means it is no longer stored.
         */
        async process(eventId, options = {}) {
            const row = await store.get(eventId);
            if (!row) return { outcome: 'missing' };
            if (row.status !== 'received') return { outcome: 'skipped' };

            const controller = new AbortController();
            let timer = null;
            if (options.budgetMs) {
                timer = setTimeout(() => controller.abort(), options.budgetMs);
            }
            const started = now();
            try {
                const event = publicEvent(row);
                const info = { eventId, attempt: row.attempts + 1, signal: controller.signal, log };
                await runHandlers(handlers, event, info);
                // Your modules' event handlers (for example Deals archiving a deleted contact's deals). A failure retries the whole event like a failed handler.
                if (onEvent) await onEvent(event, info);
            } catch (err) {
                const message = err && err.message ? err.message : 'handler failed';
                const failures = await store.noteFailure(eventId, message, now() + backoffMs(row.attempts + 1));
                await log.error('Handler failed for ' + (row.event || 'event') + ' ' + eventId + ' (attempt ' + failures + ' of ' + maxAttempts + '):', message);
                if (failures >= maxAttempts) {
                    await store.markFailed(eventId, message);
                    await publish(eventId);
                    return { outcome: 'failed', error: message };
                }
                return { outcome: 'retry', error: message };
            } finally {
                if (timer) clearTimeout(timer);
            }
            if (options.budgetMs && now() - started > options.budgetMs) {
                await log.warn('A handler for ' + (row.event || 'event') + ' ' + eventId + ' overran the ' + options.budgetMs
                    + ' ms inline budget: this handler is too slow for inline mode; set DC_WEBHOOKS to a queue mode.');
            }
            if (row.event === 'contact.deleted' && row.contact_id) {
                await store.purgeContact(row.contact_id, eventId);
            }
            await store.markProcessed(eventId);
            await publish(eventId);
            return { outcome: 'processed' };
        }
    };
}
