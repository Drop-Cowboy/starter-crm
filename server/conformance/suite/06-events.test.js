import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { deliver, eventBody, urlFor } from '../lib/context.js';

// Opens /api/events and collects SSE messages until `until(messages)` is true.
async function collect({ headers = {}, until, timeoutMs = 5000, onOpen }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(urlFor('login', '/api/events'), { headers, signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);

    if (onOpen) await onOpen();

    const messages = [];
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body.getReader();
    while (!until(messages)) {
        const chunk = await reader.read().catch(() => ({ done: true }));
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
            const message = parseBlock(block);
            if (message) messages.push(message);
        }
    }
    clearTimeout(timer);
    controller.abort();
    return messages;
}

function parseBlock(block) {
    let id = null;
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return null;
    return { id, event, data: JSON.parse(data.join('\n')) };
}

describe('GET /api/events', () => {
    it('pushes a verified webhook to an open stream', async () => {
        const eventId = crypto.randomUUID();
        const messages = await collect({
            until: (m) => m.some((x) => x.id === eventId),
            onOpen: async () => {
                const res = await deliver('login', eventBody(eventId), { headers: { 'x-event-id': eventId, 'x-attempt': '2' } });
                assert.equal(res.status, 200);
            }
        });

        const message = messages.find((x) => x.id === eventId);
        assert.ok(message, 'the event never arrived on the stream');
        assert.equal(message.event, 'message', 'events use the default SSE type so onmessage receives them');
        assert.equal(message.data.event_id, eventId);
        assert.equal(message.data.event, 'contact.msg.received');
        assert.equal(typeof message.data.event_at, 'number');
        assert.equal(typeof message.data.received_at, 'number');
        assert.equal(message.data.attempt, 2);
        assert.deepEqual(message.data.data, {
            contact_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
            body: 'Yes, call me back',
            from: '+13125550142'
        });
    });

    it('replays only events after Last-Event-ID', async () => {
        const first = crypto.randomUUID();
        const second = crypto.randomUUID();
        await deliver('login', eventBody(first));
        await deliver('login', eventBody(second));

        const messages = await collect({
            headers: { 'last-event-id': first },
            until: (m) => m.some((x) => x.id === second)
        });
        assert.equal(messages[0] && messages[0].id, second);
        assert.ok(!messages.some((x) => x.id === first));
    });

    it('does not push rejected or duplicate deliveries', async () => {
        const accepted = crypto.randomUUID();
        const rejected = crypto.randomUUID();
        const marker = crypto.randomUUID();
        await deliver('login', eventBody(accepted));
        await deliver('login', eventBody(rejected), { secret: 'wrong-secret' });
        await deliver('login', eventBody(accepted));
        await deliver('login', eventBody(marker));

        const messages = await collect({
            headers: { 'last-event-id': accepted },
            until: (m) => m.some((x) => x.id === marker)
        });
        assert.deepEqual(messages.filter((x) => x.event === 'message').map((x) => x.id), [marker]);
    });

    it('ends the replay with a named replayed event, before any live event', async () => {
        const buffered = crypto.randomUUID();
        const live = crypto.randomUUID();
        await deliver('login', eventBody(buffered));

        const messages = await collect({
            until: (m) => m.some((x) => x.id === live),
            onOpen: async () => {
                await new Promise((resolve) => setTimeout(resolve, 200));
                await deliver('login', eventBody(live));
            }
        });

        const kinds = messages.map((x) => (x.event === 'replayed' ? 'replayed' : x.id));
        const end = kinds.indexOf('replayed');
        assert.notEqual(end, -1, 'the stream never sent event: replayed');
        assert.equal(kinds.lastIndexOf('replayed'), end, 'replayed is sent once per connection');
        assert.ok(kinds.indexOf(buffered) < end, 'buffered events come before replayed');
        assert.ok(kinds.indexOf(live) > end, 'live events come after replayed');
        assert.equal(messages[end].id, null, 'replayed carries no id, so it cannot move Last-Event-ID');
        assert.deepEqual(messages[end].data, {});
    });

    it('sends replayed even when there is nothing to replay', async () => {
        const marker = crypto.randomUUID();
        await deliver('login', eventBody(marker));

        const messages = await collect({
            headers: { 'last-event-id': marker },
            until: (m) => m.some((x) => x.event === 'replayed')
        });
        assert.deepEqual(messages.map((x) => x.event), ['replayed']);
    });
});
