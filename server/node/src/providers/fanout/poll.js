/**
 * The `poll` fan-out: each instance asks the store for new finished events on a timer.
 *
 * Where it sits: `DC_FANOUT=poll`, the fallback that works with any durable store
 * (including DynamoDB) and on hosts that cannot hold a pub/sub connection. The
 * cost is latency: an event reaches a browser on another instance within
 * `DC_FANOUT_POLL_MS` (default 1000) instead of at once. The timer runs only while at
 * least one event stream is connected, so an idle instance does no work.
 *
 * An event finished on this instance is also delivered to this instance's streams
 * straight away; the poll later finds it again and the streams' de-duplication by id
 * drops the repeat.
 *
 * CONTRACT.md: "Fan-out".
 * Env: DC_FANOUT_POLL_MS. What a customer changes: nothing.
 */

import { createHub } from './hub.js';

export const name = 'poll';
export const configKeys = ['DC_FANOUT_POLL_MS'];

/**
 * Nothing beyond the interval, which the config parser checks.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the fan-out.
 *
 * @param {{ config: object, store: object }} ctx Provider context; `store` is polled.
 * @returns {object} The fan-out instance.
 */
export function create(ctx) {
    const hub = createHub();
    const intervalMs = ctx.config.events.fanoutPollMs;
    let timer = null;
    let cursor = null;
    let polling = false;
    let lastError = null;

    /**
     * One poll: reads what finished since the cursor and delivers it. A stream
     * that has already seen an event drops the repeat, so overlap is harmless.
     *
     * @returns {Promise<void>}
     */
    async function tick() {
        if (polling) return;
        polling = true;
        try {
            const events = await ctx.store.since({ afterEventId: cursor || undefined });
            for (const event of events) hub.deliver(event);
            if (events.length > 0) cursor = events[events.length - 1].event_id;
            lastError = null;
        } catch (err) {
            // The next tick tries again, and /readyz goes red through ready() while the store is unreachable.
            lastError = err;
        } finally {
            polling = false;
        }
    }

    return {
        async publish(event) {
            hub.deliver(event);
        },
        subscribe(handler, { afterEventId } = {}) {
            const unsubscribe = hub.subscribe(handler);
            if (timer === null) {
                // The first stream starts the clock from where its browser left off.
                cursor = afterEventId || null;
                timer = setInterval(tick, intervalMs);
                timer.unref?.();
            }
            return () => {
                unsubscribe();
                if (hub.size() === 0 && timer !== null) {
                    clearInterval(timer);
                    timer = null;
                }
            };
        },
        async ready() {
            return lastError === null;
        },
        async close() {
            if (timer !== null) clearInterval(timer);
            timer = null;
        }
    };
}
