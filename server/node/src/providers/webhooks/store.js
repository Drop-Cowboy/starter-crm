/**
 * The `store` webhook mode: a durable outbox in the event store.
 *
 * Where it sits: `DC_WEBHOOKS=store`, the default whenever no queue is configured, on
 * a long-running host. The webhook records the event as `received` and answers 200;
 * a worker then picks received events up from the store, runs the handlers, and
 * finishes them. Because the event is in the store before the answer, a crash
 * loses nothing: the next worker finds it. Nothing needs installing beyond the
 * store you already chose.
 *
 * The worker runs in the web process by default and drains with backoff on failure. Set
 * `DC_WORKER_IN_PROCESS=off` and run `npm run worker` to move it to its own process
 * (it needs a shared store: sqlite on one machine, or postgres or redis). On SIGTERM
 * it waits for the event in hand, up to the shutdown grace period.
 *
 * Dispatcher interface: `dispatch(eventId)` -> `{ outcome }`, `start()`, `stop()`,
 * `ready()`, optional `sweep(eventIds)`, and `visibleDelayMs`: how long a freshly
 * recorded event stays out of the sweep's reach.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
 * Env: DC_OUTBOX_POLL_MS, DC_WORKER_IN_PROCESS. What a customer changes: nothing.
 */

export const name = 'store';
export const configKeys = ['DC_OUTBOX_POLL_MS', 'DC_WORKER_IN_PROCESS'];

/** How many received events one pass claims. */
const BATCH = 10;

/** How long a worker holds a claimed event before another worker may take it. */
const LEASE_MS = 60000;

/**
 * Nothing beyond the settings the config parser checks.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the dispatcher.
 *
 * @param {{ config: object, store: object, processor: object, log: object }} ctx Provider context.
 * @returns {object} The dispatcher.
 */
export function create(ctx) {
    const pollMs = ctx.config.events.outboxPollMs;
    let running = false;
    let loop = null;
    let wake = null;
    let kicked = false;
    let lastError = null;

    /**
     * Sleeps until the poll interval passes or something wakes the worker, whichever is first.
     *
     * @returns {Promise<void>}
     */
    function rest() {
        // A webhook that arrived while the worker was busy has already kicked it; do not sleep through that.
        if (kicked) {
            kicked = false;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            wake = () => {
                clearTimeout(timer);
                wake = null;
                kicked = false;
                resolve();
            };
        });
    }

    /**
     * The worker: claims due events, processes them, and rests when there is nothing to do.
     *
     * @returns {Promise<void>} Resolves after stop() when the event in hand has finished.
     */
    async function work() {
        let failures = 0;
        while (running) {
            let claimed;
            try {
                claimed = await ctx.store.pending({ limit: BATCH, leaseMs: LEASE_MS });
                failures = 0;
                lastError = null;
            } catch (err) {
                lastError = err;
                failures++;
                await ctx.log.error('The outbox could not read the event store:', err.message);
                // Back off while the store is down, up to 30 seconds.
                await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs * 2 ** failures, 30000)));
                continue;
            }
            for (const row of claimed) {
                try {
                    await ctx.processor.process(row.event_id);
                } catch (err) {
                    await ctx.log.error('The outbox could not process ' + row.event_id + ':', err.message);
                }
            }
            if (claimed.length < BATCH && running) await rest();
        }
    }

    return {
        visibleDelayMs: 0,
        async dispatch() {
            // The event is already recorded; waking the worker only saves it the wait for the next poll.
            kicked = true;
            if (wake) wake();
            return { outcome: 'queued' };
        },
        async start() {
            if (!ctx.config.events.workerInProcess || running) return;
            running = true;
            loop = work();
        },
        async stop() {
            running = false;
            if (wake) wake();
            if (loop) await loop;
            loop = null;
        },
        async ready() {
            return lastError === null;
        }
    };
}
