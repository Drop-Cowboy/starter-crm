const KEEPALIVE_MS = 25000;

// In memory, so events vanish on restart. A real CRM writes them to its own
// database or a queue before answering the webhook.
export function createEventStore({ maxEvents = 200, maxSeenIds = 1000 } = {}) {
    const events = [];
    const seen = new Set();
    const listeners = new Set();

    return {
        hasSeen(eventId) {
            return seen.has(eventId);
        },

        add(event) {
            seen.add(event.event_id);
            if (seen.size > maxSeenIds) {
                seen.delete(seen.values().next().value);
            }
            events.push(event);
            if (events.length > maxEvents) {
                events.shift();
            }
            for (const listener of listeners) {
                listener(event);
            }
        },

        // Events after `lastEventId`, or all of them when that id is unknown.
        since(lastEventId) {
            const index = lastEventId ? events.findIndex((e) => e.event_id === lastEventId) : -1;
            return events.slice(index + 1);
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

// Server-Sent Events: the browser opens `new EventSource('/api/events')` and
// receives each verified webhook as a `message`.
export function eventsRoute(store) {
    return function streamEvents(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write('retry: 3000\n\n');

        const send = (event) => {
            res.write('id: ' + event.event_id + '\ndata: ' + JSON.stringify(event) + '\n\n');
        };
        for (const event of store.since(req.get('last-event-id'))) {
            send(event);
        }
        // Named, so onmessage never sees it. Tells the page that what came
        // before was history and what follows is live.
        res.write('event: replayed\ndata: {}\n\n');

        const unsubscribe = store.subscribe(send);
        const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
        req.on('close', () => {
            clearInterval(keepalive);
            unsubscribe();
        });
    };
}
