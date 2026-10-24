// A Server-Sent Events client that sends request headers, for servers that
// identify the user by an Authorization header (the oidc identity).
//
// Why it exists: the browser's EventSource cannot set headers, so a bearer
// token cannot travel with it. With the passcode identity the session cookie
// rides on a plain EventSource, and this file is not used. This one has the
// same surface connectEvents() relies on (onopen, onmessage, onerror,
// addEventListener, readyState, close, and the static CLOSED), so events.js
// can swap one for the other.
//
// One difference, on purpose: a dropped connection ends this source (readyState
// CLOSED) instead of reconnecting by itself, and connectEvents() then opens a
// fresh one with a growing delay and a fresh token. A new connection replays
// the buffered events, and events are de-duplicated by id, so nothing doubles.

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/**
 * Builds an EventSource-compatible class that reads the stream with fetch().
 *
 * @param {{
 *   getHeaders: () => Promise<Record<string, string>> | Record<string, string>,
 *   fetch?: typeof fetch
 * }} options `getHeaders` runs on every connection, so a refreshed token is picked up.
 * @returns {typeof EventSource} A class to pass to connectEvents() as EventSourceImpl.
 */
export function createFetchEventSource(options) {
    const fetchImpl = options.fetch || globalThis.fetch;

    return class FetchEventSource {
        static CONNECTING = CONNECTING;
        static OPEN = OPEN;
        static CLOSED = CLOSED;

        /**
         * Opens the stream at once.
         *
         * @param {string} url Same-origin path of the event stream.
         */
        constructor(url) {
            this.url = url;
            this.readyState = CONNECTING;
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this.listeners = {};
            this.controller = new AbortController();
            this.pump();
        }

        /**
         * Adds a listener for a named event, such as the server's "replayed" marker.
         *
         * @param {string} type The SSE event name.
         * @param {(message: { data: string }) => void} listener Called with the event's data.
         */
        addEventListener(type, listener) {
            (this.listeners[type] = this.listeners[type] || []).push(listener);
        }

        /** Stops reading and never reconnects. */
        close() {
            this.readyState = CLOSED;
            this.controller.abort();
        }

        fail() {
            if (this.readyState === CLOSED && this.controller.signal.aborted) {
                return;
            }
            this.readyState = CLOSED;
            if (this.onerror) {
                this.onerror({});
            }
        }

        dispatch(type, data, lastEventId) {
            const message = { data, lastEventId, type };
            if (type === 'message') {
                if (this.onmessage) {
                    this.onmessage(message);
                }
                return;
            }
            for (const listener of this.listeners[type] || []) {
                listener(message);
            }
        }

        async pump() {
            let response;
            try {
                const headers = Object.assign({ Accept: 'text/event-stream' }, await options.getHeaders());
                response = await fetchImpl(this.url, {
                    headers,
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: this.controller.signal
                });
            } catch {
                this.fail();
                return;
            }
            const type = response.headers.get('content-type') || '';
            if (!response.ok || !/^text\/event-stream/i.test(type) || !response.body) {
                this.fail();
                return;
            }
            this.readyState = OPEN;
            if (this.onopen) {
                this.onopen({});
            }
            try {
                await this.read(response.body.getReader());
            } catch {
                // An aborted read is close(); anything else is a dropped connection.
            }
            this.fail();
        }

        async read(reader) {
            const decoder = new TextDecoder();
            let buffer = '';
            let event = { type: 'message', data: [], id: '' };
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
                let newline = buffer.search(/\r\n|\n|\r/);
                while (newline !== -1) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
                    event = this.line(line, event);
                    newline = buffer.search(/\r\n|\n|\r/);
                }
            }
        }

        line(text, event) {
            if (text === '') {
                if (event.data.length > 0) {
                    this.dispatch(event.type, event.data.join('\n'), event.id);
                }
                return { type: 'message', data: [], id: event.id };
            }
            if (text.startsWith(':')) {
                return event;
            }
            const colon = text.indexOf(':');
            const field = colon === -1 ? text : text.slice(0, colon);
            let value = colon === -1 ? '' : text.slice(colon + 1);
            if (value.startsWith(' ')) {
                value = value.slice(1);
            }
            if (field === 'data') {
                event.data.push(value);
            } else if (field === 'event') {
                event.type = value || 'message';
            } else if (field === 'id') {
                event.id = value;
            }
            return event;
        }
    };
}
