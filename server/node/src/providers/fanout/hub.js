/**
 * A tiny in-process subscriber list that every fan-out provider uses to hand an
 * event to the event streams connected to this instance.
 *
 * Where it sits: fan-out providers decide how an event travels between
 * instances (not at all, Redis, Postgres, or polling the store). Once it
 * arrives, the same hub delivers it to each open `/api/events` stream here.
 *
 * CONTRACT.md: "Fan-out".
 * What a customer changes: nothing.
 */

/**
 * Creates a hub.
 *
 * @returns {{ subscribe: (handler: Function) => (() => void), deliver: (event: object) => void, size: () => number }}
 *   `subscribe` returns the unsubscribe function; `deliver` calls every handler with the event.
 */
export function createHub() {
    const handlers = new Set();
    return {
        subscribe(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        deliver(event) {
            for (const handler of [...handlers]) {
                // One stream failing to write must not stop the others from receiving the event.
                try {
                    handler(event);
                } catch {
                    // The stream is closing; its own cleanup removes the handler.
                }
            }
        },
        size() {
            return handlers.size;
        }
    };
}
