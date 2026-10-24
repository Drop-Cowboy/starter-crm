import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFetchEventSource } from '../fetch-event-source.js';

function streamOf(chunks) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        }
    });
}

function answer(chunks, init) {
    return new Response(streamOf(chunks), Object.assign({ status: 200, headers: { 'Content-Type': 'text/event-stream' } }, init));
}

function until(predicate) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        (function check() {
            if (predicate()) {
                resolve();
            } else if (Date.now() - started > 2000) {
                reject(new Error('timed out'));
            } else {
                setTimeout(check, 5);
            }
        })();
    });
}

describe('createFetchEventSource', () => {
    it('sends the identity header and Accept, and reads messages and named events', async () => {
        const calls = [];
        const Source = createFetchEventSource({
            getHeaders: async () => ({ Authorization: 'Bearer abc' }),
            fetch: async (url, init) => {
                calls.push({ url, init });
                return answer([': keepalive\n\n', 'retry: 3000\n\n', 'data: {"event_id":"a"}\n\n', 'event: replayed\ndata: {}\n\n']);
            }
        });
        const messages = [];
        const named = [];
        const source = new Source('/api/events');
        source.onmessage = (message) => messages.push(message.data);
        source.addEventListener('replayed', (message) => named.push(message.data));
        let opened = false;
        source.onopen = () => {
            opened = true;
        };
        await until(() => named.length === 1);
        assert.equal(opened, true);
        assert.deepEqual(messages, ['{"event_id":"a"}']);
        assert.equal(calls[0].url, '/api/events');
        assert.equal(calls[0].init.headers.Authorization, 'Bearer abc');
        assert.equal(calls[0].init.headers.Accept, 'text/event-stream');
    });

    it('joins multi-line data and handles a message split across chunks and CRLF', async () => {
        const Source = createFetchEventSource({
            getHeaders: () => ({}),
            fetch: async () => answer(['data: one\r\ndata: tw', 'o\r\n\r\n'])
        });
        const messages = [];
        const source = new Source('/x');
        source.onmessage = (message) => messages.push(message.data);
        await until(() => messages.length === 1);
        assert.equal(messages[0], 'one\ntwo');
    });

    it('closes, and reports an error, for an error status', async () => {
        const Source = createFetchEventSource({
            getHeaders: () => ({}),
            fetch: async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })
        });
        let failed = 0;
        const source = new Source('/x');
        source.onerror = () => {
            failed += 1;
        };
        await until(() => failed === 1);
        assert.equal(source.readyState, Source.CLOSED);
    });

    it('reports an error when the stream ends, so the caller reconnects with a fresh token', async () => {
        const Source = createFetchEventSource({ getHeaders: () => ({}), fetch: async () => answer(['data: a\n\n']) });
        let failed = 0;
        const source = new Source('/x');
        source.onmessage = () => {};
        source.onerror = () => {
            failed += 1;
        };
        await until(() => failed === 1);
        assert.equal(source.readyState, Source.CLOSED);
    });

    it('does not report an error for a close() the caller asked for', async () => {
        const Source = createFetchEventSource({
            getHeaders: () => ({}),
            fetch: async (url, init) => new Promise((resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')));
            })
        });
        let failed = 0;
        const source = new Source('/x');
        source.onerror = () => {
            failed += 1;
        };
        source.close();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(failed, 0);
        assert.equal(source.readyState, Source.CLOSED);
    });
});
