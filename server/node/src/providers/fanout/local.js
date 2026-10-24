/**
 * The `local` fan-out: events reach only the event streams on this instance.
 *
 * Where it sits: `DC_FANOUT=local`, the default for the memory and sqlite stores.
 * The webhook and the browser must reach the same instance, which is always true
 * with one instance. With several, use `redis`, `postgres` or `poll`.
 *
 * Fan-out interface: `publish(event)`, `subscribe(handler, { afterEventId }) -> unsubscribe`,
 * `ready()` and `close()`. All but `subscribe` return promises. `afterEventId` is the
 * browser's `Last-Event-ID`, which a polling fan-out starts from; the others ignore it.
 *
 * CONTRACT.md: "Fan-out".
 * What a customer changes: nothing.
 */

import { createHub } from './hub.js';

export const name = 'local';
export const configKeys = [];

/**
 * Nothing to configure.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the fan-out.
 *
 * @returns {object} The fan-out instance.
 */
export function create() {
    const hub = createHub();
    return {
        async publish(event) {
            hub.deliver(event);
        },
        subscribe: hub.subscribe,
        async ready() {
            return true;
        },
        async close() {}
    };
}
