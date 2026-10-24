// Live webhook events from the starter server (GET /api/events, Server-Sent
// Events). Drop Cowboy posts a signed webhook to the server, the server
// verifies it and pushes it here, and the page shows it in the activity feed.
//
// EventSource reconnects by itself after a dropped connection, and sends
// Last-Event-ID so the server replays only what was missed. It gives up for
// good when the server answers with an error status (readyState CLOSED), so
// that case is retried here, with a growing delay. A fresh connection gets
// every buffered event again, which is why events are de-duplicated by id.
//
// The server ends each replay with a "replayed" event. On the first
// connection, what came before it is history the page loaded with, so it is
// passed on with { replayed: true }: show it, but do not announce it. Anything
// a later connection brings that was not already seen was missed, so it is new.

import { createFetchEventSource } from './fetch-event-source.js';
import { getAuthHeader, hasAuthHeaderProvider } from './server-api.js';

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

/**
 * @typedef {object} WebhookEvent
 * @property {string} event_id
 * @property {string | null} event       e.g. "contact.rvm.status"
 * @property {number | null} event_at
 * @property {number} received_at
 * @property {number} attempt
 * @property {Record<string, unknown>} data
 */

/**
 * @param {{
 *   url?: string,
 *   onEvent: (event: WebhookEvent, meta: { replayed: boolean }) => void,
 *   onStatus?: (status: 'connecting' | 'open' | 'reconnecting') => void,
 *   EventSourceImpl?: typeof EventSource,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout
 * }} options
 * @returns {{ close(): void }}
 */
export function connectEvents(options) {
    const url = options.url || '/api/events';
    // The browser's EventSource cannot send an Authorization header, so when the
    // page registered one (the oidc identity), the stream is read with fetch().
    // Otherwise the plain EventSource carries the session cookie by itself.
    const EventSourceImpl = options.EventSourceImpl
        || (hasAuthHeaderProvider() ? createFetchEventSource({ getHeaders: getAuthHeader }) : globalThis.EventSource);
    const later = options.setTimeoutImpl || globalThis.setTimeout;
    const cancel = options.clearTimeoutImpl || globalThis.clearTimeout;
    const onStatus = options.onStatus || function () {};
    const seen = new Set();
    let source = null;
    let timer = null;
    let delay = FIRST_RETRY_MS;
    let closed = false;
    let replaying = true;

    function handleMessage(message) {
        let event;
        try {
            event = JSON.parse(message.data);
        } catch {
            return;
        }
        if (!event || !event.event_id || seen.has(event.event_id)) {
            return;
        }
        seen.add(event.event_id);
        options.onEvent(event, { replayed: replaying });
    }

    function endReplay() {
        replaying = false;
    }

    function handleError() {
        if (closed) {
            return;
        }
        onStatus('reconnecting');
        if (source.readyState === EventSourceImpl.CLOSED) {
            source = null;
            endReplay();
            timer = later(open, delay);
            delay = Math.min(delay * 2, MAX_RETRY_MS);
        }
    }

    function open() {
        timer = null;
        onStatus('connecting');
        source = new EventSourceImpl(url);
        source.onopen = function () {
            delay = FIRST_RETRY_MS;
            onStatus('open');
        };
        source.onmessage = handleMessage;
        source.onerror = handleError;
        source.addEventListener('replayed', endReplay);
    }

    open();

    return {
        close: function () {
            closed = true;
            if (timer) {
                cancel(timer);
            }
            if (source) {
                source.close();
            }
        }
    };
}
