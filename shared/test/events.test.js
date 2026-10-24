import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActivityLog, fromDock, fromWebhook, webhookFamily } from '../activity.js';
import { connectEvents } from '../events.js';
import { setAuthHeaderProvider } from '../server-api.js';

class FakeEventSource {
    static CLOSED = 2;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.closed = false;
        this.listeners = {};
        FakeEventSource.instances.push(this);
    }

    addEventListener(type, listener) {
        (this.listeners[type] = this.listeners[type] || []).push(listener);
    }

    close() {
        this.closed = true;
    }

    emit(event) {
        this.onmessage({ data: JSON.stringify(event) });
    }

    endReplay() {
        for (const listener of this.listeners.replayed || []) {
            listener({ data: '{}' });
        }
    }
}

const LATER = { event_id: 'a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b', event: 'contact.rvm.status', data: { status: 'success' } };
const MISSED = { event_id: '8f3e1a9c-2d4b-4e7a-9c1f-5b6a7c8d9e0f', event: 'contact.call.missed', data: {} };

function fakeTimers() {
    const timers = [];
    return {
        timers,
        setTimeoutImpl: (fn, ms) => {
            timers.push({ fn, ms });
            return timers.length;
        },
        clearTimeoutImpl: () => {}
    };
}

const EVENT = { event_id: 'd1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c', event: 'contact.msg.received', data: { contact_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', from: '+13125550142' } };

describe('connectEvents', () => {
    it('delivers each event once, even when a reconnect replays it', () => {
        FakeEventSource.instances = [];
        const timers = fakeTimers();
        const received = [];
        connectEvents({ EventSourceImpl: FakeEventSource, onEvent: (e) => received.push(e), ...timers });

        const first = FakeEventSource.instances[0];
        assert.equal(first.url, '/api/events');
        first.emit(EVENT);
        first.readyState = FakeEventSource.CLOSED;
        first.onerror();

        assert.equal(timers.timers[0].ms, 1000);
        timers.timers[0].fn();
        FakeEventSource.instances[1].emit(EVENT);
        assert.equal(received.length, 1);
    });

    it('backs off while the server keeps refusing, and resets once connected', () => {
        FakeEventSource.instances = [];
        const timers = fakeTimers();
        const statuses = [];
        connectEvents({ EventSourceImpl: FakeEventSource, onEvent: () => {}, onStatus: (s) => statuses.push(s), ...timers });

        for (let i = 0; i < 3; i++) {
            const source = FakeEventSource.instances[i];
            source.readyState = FakeEventSource.CLOSED;
            source.onerror();
            timers.timers[i].fn();
        }
        assert.deepEqual(timers.timers.map((t) => t.ms), [1000, 2000, 4000]);
        FakeEventSource.instances[3].onopen();
        assert.equal(statuses[statuses.length - 1], 'open');
    });

    it('leaves a temporary drop to the browser\'s own reconnect', () => {
        FakeEventSource.instances = [];
        const timers = fakeTimers();
        connectEvents({ EventSourceImpl: FakeEventSource, onEvent: () => {}, ...timers });
        FakeEventSource.instances[0].onerror();
        assert.equal(timers.timers.length, 0);
    });

    it('stops for good on close()', () => {
        FakeEventSource.instances = [];
        const timers = fakeTimers();
        const stream = connectEvents({ EventSourceImpl: FakeEventSource, onEvent: () => {}, ...timers });
        stream.close();
        const source = FakeEventSource.instances[0];
        assert.equal(source.closed, true);
        source.readyState = FakeEventSource.CLOSED;
        source.onerror();
        assert.equal(timers.timers.length, 0);
    });

    it('marks the replay the page loads with, and nothing after it', () => {
        FakeEventSource.instances = [];
        const received = [];
        connectEvents({ EventSourceImpl: FakeEventSource, onEvent: (e, meta) => received.push([e.event_id, meta.replayed]), ...fakeTimers() });

        const source = FakeEventSource.instances[0];
        source.emit(EVENT);
        source.endReplay();
        source.emit(LATER);
        assert.deepEqual(received, [[EVENT.event_id, true], [LATER.event_id, false]]);
    });

    it('treats what a reconnect brings as new, since the page missed it', () => {
        FakeEventSource.instances = [];
        const timers = fakeTimers();
        const received = [];
        connectEvents({ EventSourceImpl: FakeEventSource, onEvent: (e, meta) => received.push([e.event_id, meta.replayed]), ...timers });

        const first = FakeEventSource.instances[0];
        first.emit(EVENT);
        first.readyState = FakeEventSource.CLOSED;
        first.onerror();
        timers.timers[0].fn();

        const second = FakeEventSource.instances[1];
        second.emit(EVENT);
        second.emit(MISSED);
        second.endReplay();
        assert.deepEqual(received, [[EVENT.event_id, true], [MISSED.event_id, false]]);
    });

    it('ignores messages that are not events', () => {
        FakeEventSource.instances = [];
        const received = [];
        connectEvents({ EventSourceImpl: FakeEventSource, onEvent: (e) => received.push(e), ...fakeTimers() });
        FakeEventSource.instances[0].onmessage({ data: 'not json' });
        FakeEventSource.instances[0].onmessage({ data: '{}' });
        assert.equal(received.length, 0);
    });
});

describe('activity', () => {
    it('labels a webhook and links it to its contact', () => {
        const item = fromWebhook(Object.assign({ received_at: 5 }, EVENT));
        assert.equal(item.title, 'Text received');
        assert.equal(item.contactId, EVENT.data.contact_id);
        assert.match(item.detail, /\+13125550142/);
        assert.equal(item.event, EVENT.event);
        assert.equal(item.family, 'text');
        assert.equal(item.replayed, false);
        assert.equal(fromWebhook(EVENT, { replayed: true }).replayed, true);
        assert.equal(fromDock('callEnded', {}).replayed, false);
    });

    it('sorts events into families for their icons', () => {
        assert.equal(webhookFamily('contact.call.missed'), 'call');
        assert.equal(webhookFamily('contact.rvm.status'), 'voicemail');
        assert.equal(webhookFamily('contact.msg.opt_out'), 'consent');
        assert.equal(webhookFamily('contact.consent.granted'), 'consent');
        assert.equal(webhookFamily('contact.pipeline.stage.entered'), 'pipeline');
        assert.equal(webhookFamily('campaign.started'), 'other');
        assert.equal(webhookFamily(null), 'other');
        assert.equal(fromDock('messageSent', {}).family, 'text');
        assert.equal(fromDock('callEnded', {}).event, null);
    });

    it('shows unknown events by name and keeps the newest first', () => {
        const log = createActivityLog();
        const seen = [];
        log.subscribe((items) => seen.push(items.length));
        log.add(fromWebhook({ event_id: 'a', event: 'contact.tag.added', data: {} }));
        log.add(fromWebhook({ event_id: 'b', event: null, data: {} }));
        assert.equal(log.items()[0].title, 'webhook');
        assert.equal(log.items()[1].title, 'contact.tag.added');
        assert.deepEqual(seen, [1, 2]);
    });
});

describe('connectEvents with an identity header', () => {
    it('reads the stream with fetch, carrying the header, because EventSource cannot send one', async () => {
        const calls = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            calls.push({ url, init });
            return new Response(null, { status: 401 });
        };
        setAuthHeaderProvider(() => ({ Authorization: 'Bearer from-the-page' }));
        const timers = fakeTimers();
        try {
            const events = connectEvents({ onEvent() {}, setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
            await new Promise((resolve) => setTimeout(resolve, 20));
            events.close();
            assert.equal(calls.length, 1);
            assert.equal(calls[0].url, '/api/events');
            assert.equal(calls[0].init.headers.Authorization, 'Bearer from-the-page');
            assert.equal(timers.timers.length, 1, 'a refused stream is retried later, with a fresh header');
        } finally {
            setAuthHeaderProvider(null);
            globalThis.fetch = realFetch;
        }
    });
});
