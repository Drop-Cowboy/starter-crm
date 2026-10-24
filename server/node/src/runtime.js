/**
 * The event runtime: the store, the fan-out, the webhook mode and the processor,
 * wired together and supervised as one unit.
 *
 * Where it sits: bootstrap.js builds it from the providers the config names; core.js
 * takes it as `deps.runtime`; index.js (and worker.js) calls `start()` after listening
 * and `stop()` on shutdown. Tests that do not boot use `defaultRuntime()`: a memory store,
 * a local fan-out and inline handling, so a webhook is processed and pushed within the
 * request.
 *
 * `start()` runs the webhook mode's worker (unless `DC_WORKER_IN_PROCESS=off`) and a
 * maintenance loop that, every minute, re-queues events no worker has finished (a crash, a
 * flushed Redis) and, hourly, deletes events past `DC_EVENT_RETENTION_HOURS`. Both loops
 * are awaited on `stop()`, so shutdown never abandons work in hand.
 *
 * CONTRACT.md: "Event store", "Fan-out", "POST /webhooks/dropcowboy", Shutdown.
 * What a customer changes: nothing.
 */

import { createProcessor } from './processor.js';
import * as memoryData from './providers/data/memory.js';
import * as localFanout from './providers/fanout/local.js';
import * as memoryStore from './providers/store/memory.js';
import * as inlineWebhooks from './providers/webhooks/inline.js';

/** How often the maintenance loop looks for events no worker has finished. */
const SWEEP_EVERY_MS = 60000;

/** How many sweeps pass between retention prunes (60 sweeps is an hour). */
const PRUNE_EVERY_SWEEPS = 60;

/** How many stale events one sweep re-queues. */
const SWEEP_BATCH = 50;

/**
 * Wires the four pieces together.
 *
 * @param {{ config: object, store: object, fanout: object, dispatcher: object, processor: object, log: object,
 *   data?: object|null, modules?: object|null }} parts
 *   Created by bootstrap.js (or by defaultRuntime()). `data` is the module-data provider and `modules` what
 *   createModules() built; both are null when nothing uses them.
 * @returns {object} The runtime: `store`, `fanout`, `dispatcher`, `processor`, `data`, `modules`, `start()`, `stop()`, `maintainOnce()` and `ready()`.
 */
export function createRuntime({ config, store, fanout, dispatcher, processor, log, data = null, modules = null }) {
    let running = false;
    let loop = null;
    let wake = null;

    /**
     * One maintenance pass: re-queue stale events through the webhook mode, and now and then prune.
     *
     * @param {number} count Which pass this is, counting from 1.
     * @returns {Promise<void>}
     */
    async function maintain(count) {
        if (typeof dispatcher.sweep === 'function') {
            const due = await store.pending({ limit: SWEEP_BATCH, leaseMs: SWEEP_EVERY_MS });
            if (due.length > 0) {
                await log.warn('Re-queueing ' + due.length + ' event(s) that no worker finished.');
                await dispatcher.sweep(due.map((row) => row.event_id));
            }
        }
        if (count % PRUNE_EVERY_SWEEPS === 0) await store.prune();
    }

    /**
     * The maintenance loop: sleeps, then maintains, until stop().
     *
     * @returns {Promise<void>} Resolves after stop().
     */
    async function maintenanceLoop() {
        let count = 0;
        while (running) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, SWEEP_EVERY_MS);
                wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            wake = null;
            if (!running) break;
            count++;
            try {
                await maintain(count);
            } catch (err) {
                await log.warn('Event maintenance failed; it will try again:', err.message);
            }
        }
    }

    return {
        store,
        fanout,
        dispatcher,
        processor,
        data,
        modules,

        /**
         * Starts the worker and the maintenance loop, and prunes once.
         *
         * @returns {Promise<void>}
         */
        async start() {
            if (running) return;
            running = true;
            await store.prune();
            await dispatcher.start();
            loop = maintenanceLoop();
        },

        /**
         * One full maintenance pass, awaited by the caller: re-queue stale events and prune past retention.
         * Serverless hosts have no loop, so a scheduled request (Vercel Cron) calls this instead.
         *
         * @returns {Promise<void>}
         */
        async maintainOnce() {
            await maintain(PRUNE_EVERY_SWEEPS);
        },

        /**
         * Stops the loops (waiting for work in hand) and closes every connection.
         *
         * @returns {Promise<void>}
         */
        async stop() {
            running = false;
            if (wake) wake();
            if (loop) await loop;
            loop = null;
            await dispatcher.stop();
            await fanout.close();
            await store.close();
            if (data) await data.close();
        },

        /**
         * Whether every piece can do its job: what /readyz reports.
         *
         * @returns {Promise<boolean>} False when the store, fan-out or webhook mode is unhealthy.
         */
        async ready() {
            const checks = await Promise.all([store.ready(), fanout.ready(), dispatcher.ready(), data ? data.ready() : true]);
            return checks.every(Boolean);
        }
    };
}

/**
 * A runtime with no external services: memory store, local fan-out, inline handling.
 *
 * @param {object} config The loaded config.
 * @param {object} log The logger.
 * @param {{ handlers?: Record<string, Function> }} [options] Handlers to run (none by default).
 * @returns {object} A runtime that is ready to use without start().
 */
export function defaultRuntime(config, log, options = {}) {
    const store = memoryStore.create({ config });
    const fanout = localFanout.create();
    const handlers = options.handlers || {};
    const processor = createProcessor({ config, store, fanout, handlers, log });
    const dispatcher = inlineWebhooks.create({ config, processor });
    return createRuntime({ config, store, fanout, dispatcher, processor, log, data: memoryData.create({ config }) });
}
