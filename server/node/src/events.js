/**
 * The `GET /api/events` Server-Sent Events stream.
 *
 * Where it sits: the browser opens `EventSource('/api/events')`. The stream first
 * replays finished events from the store (everything after the browser's
 * `Last-Event-ID`, or the latest ones), sends a named `replayed` event, and then
 * forwards each event the fan-out delivers. Events reach the fan-out after their
 * handlers have run (processor.js), on this instance or any other that shares the
 * store. On SIGTERM, lifecycle closes every open stream with `retry: 1000`, so the
 * browser reconnects after the new instance is up.
 *
 * To avoid a gap, the stream subscribes to the fan-out before it replays, holds live
 * events while the replay is sent, and drops any event it has already sent (the
 * replay and the live feed can overlap by a few seconds, by design).
 *
 * `DC_EVENTS_MAX_STREAM_SECONDS` ends each stream cleanly, with `retry: 1000`, before a
 * host's own time limit (for example a serverless function's duration); the browser
 * reconnects with `Last-Event-ID` and misses nothing.
 *
 * CONTRACT.md: GET /api/events, Shutdown.
 * Customers replace nothing here; to react to events on the server, write handlers
 * (handlers.js).
 */

/** How many event ids a stream remembers for de-duplication, enough to cover any replay plus its overlap. */
const SEEN_CAP = 1000;

/**
 * Server-Sent Events: the browser opens `new EventSource('/api/events')` and
 * receives each finished webhook event as a `message`.
 *
 * The body is a web `ReadableStream`. It ends when the client goes away (the
 * request's abort signal fires), when the lifecycle closes it on shutdown, or when
 * the stream reaches `DC_EVENTS_MAX_STREAM_SECONDS`.
 *
 * @param {{ store: { since: Function }, fanout: { subscribe: Function }, maxStreamSeconds?: number, keepaliveSeconds?: number }} deps
 *   Where replay comes from, how live events arrive, the optional stream cap, and how often an idle stream
 *   sends `: keepalive` (25 s unless the platform needs it sooner; see config.js).
 * @param {object} [lifecycle] From createLifecycle(); optional in unit tests.
 * @returns {(ctx: object) => Promise<Response>} A handler that answers with a
 *   stream that stays open.
 */
export function eventsRoute({ store, fanout, maxStreamSeconds = 0, keepaliveSeconds = 25 }, lifecycle) {
    return async function streamEvents(ctx) {
        const encoder = new TextEncoder();
        const lastEventId = ctx.request.headers.get('last-event-id');
        let cleanup = () => {};

        const body = new ReadableStream({
            async start(controller) {
                const write = (text) => {
                    try {
                        controller.enqueue(encoder.encode(text));
                    } catch {
                        // The stream is closed; cleanup() is already on its way.
                    }
                };
                // The browser already has its Last-Event-ID event, so a fan-out that repeats it is not forwarded.
                const seen = new Set(lastEventId ? [lastEventId] : []);
                const send = (event) => {
                    if (seen.has(event.event_id)) return;
                    seen.add(event.event_id);
                    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
                    write('id: ' + event.event_id + '\ndata: ' + JSON.stringify(event) + '\n\n');
                };

                let keepalive = null;
                let capTimer = null;
                let unsubscribe = () => {};
                let unregister = null;
                let cleaned = false;
                cleanup = () => {
                    if (cleaned) return;
                    cleaned = true;
                    if (keepalive) clearInterval(keepalive);
                    if (capTimer) clearTimeout(capTimer);
                    unsubscribe();
                    if (unregister) unregister();
                    ctx.request.signal.removeEventListener('abort', cleanup);
                };

                const handle = {
                    close() {
                        // Short retry so the browser reconnects after the new instance is up.
                        write('retry: 1000\n\n');
                        try {
                            controller.close();
                        } catch {
                            // Already closed.
                        }
                        cleanup();
                    }
                };
                unregister = lifecycle ? lifecycle.addStream(handle) : null;
                // The client went away: stop writing and forget the subscription.
                ctx.request.signal.addEventListener('abort', cleanup);
                if (ctx.request.signal.aborted) {
                    cleanup();
                    return;
                }

                // Subscribe first and hold live events until the replay has gone out, so nothing finishes unseen in between.
                let held = [];
                let replaying = true;
                unsubscribe = fanout.subscribe((event) => {
                    if (replaying) held.push(event);
                    else send(event);
                }, { afterEventId: lastEventId || undefined });

                // Default reconnect interval while the server is healthy.
                write('retry: 3000\n\n');
                try {
                    for (const event of await store.since({ afterEventId: lastEventId || undefined })) send(event);
                } catch (err) {
                    // The store is down: tell the browser to try again shortly instead of leaving it waiting on a stream that cannot catch up.
                    write('retry: 1000\n\n');
                    try {
                        controller.error(err);
                    } catch {
                        // Already closed.
                    }
                    cleanup();
                    return;
                }
                // Named, so onmessage never sees it. Tells the page that what came
                // before was history and what follows is live.
                write('event: replayed\ndata: {}\n\n');
                replaying = false;
                for (const event of held) send(event);
                held = [];

                keepalive = setInterval(() => write(': keepalive\n\n'), keepaliveSeconds * 1000);
                if (maxStreamSeconds > 0) capTimer = setTimeout(() => handle.close(), maxStreamSeconds * 1000);
            },
            cancel() {
                cleanup();
            }
        });

        return new Response(body, {
            status: 200,
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'connection': 'keep-alive',
                'x-accel-buffering': 'no'
            }
        });
    };
}
