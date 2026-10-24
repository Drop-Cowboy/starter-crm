/**
 * The `bullmq` webhook mode: a Redis queue of event ids, worked by BullMQ.
 *
 * Where it sits: `DC_WEBHOOKS=bullmq`, the default when `DC_REDIS_URL` is set and the
 * store is durable and shared. The webhook records the event, adds a job to the
 * queue, and answers 200 only after Redis has accepted the job. Jobs carry just the
 * `event_id`; the worker reads the event from the store, so contact data never sits in
 * the queue.
 *
 * - The job id is the `event_id`, so a duplicate delivery never queues twice.
 * - Backoff is exponential, up to `DC_WEBHOOK_MAX_ATTEMPTS`. BullMQ's failed set is the
 *   dead-letter list; `npm run webhooks:replay -- <event_id>` puts a job back.
 * - The queue name and prefix are the same in the Python server (it uses BullMQ for
 *   Python, which shares the queue format), so a Node server and a Python server can work
 *   one queue.
 * - Workers run in the web process by default. `DC_WORKER_IN_PROCESS=off` plus
 *   `npm run worker` runs them separately.
 * - Redis must use `maxmemory-policy noeviction`, or BullMQ can lose jobs. Boot checks it
 *   and refuses to start otherwise.
 *
 * Dispatcher interface: see store.js.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
 * Env: DC_REDIS_URL, DC_WORKER_IN_PROCESS. What a customer changes: nothing.
 */

import { QUEUE_NAME, bullmqPrefix, connectRedis, validateRedis } from '../../redis.js';

export const name = 'bullmq';
export const configKeys = ['DC_REDIS_URL', 'REDIS_URL', 'DC_REDIS_CLUSTER', 'DC_WORKER_IN_PROCESS'];

/** Jobs run at once per worker. Handlers are I/O-bound, and the store's lease keeps events from being taken twice. */
const CONCURRENCY = 5;

/**
 * Checks the Redis address.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    return validateRedis(env, 'DC_WEBHOOKS=bullmq');
}

/**
 * Connects to Redis, checks its eviction policy, and creates the queue (and the worker, when it runs here).
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, store: object, processor: object, log: object }} ctx Provider context.
 * @returns {Promise<object>} The dispatcher.
 * @throws {Error} When Redis could not be reached or evicts keys, with the fix in the message.
 */
export async function create(ctx) {
    // BullMQ is only needed when this mode is chosen, so it is not imported at the top of the file.
    const { Queue, Worker, UnrecoverableError } = await import('bullmq');
    const prefix = bullmqPrefix(ctx.config);
    const maxAttempts = ctx.config.events.maxAttempts;
    const probe = await connectRedis(ctx.env);
    try {
        const info = await probe.config('GET', 'maxmemory-policy');
        const policy = Array.isArray(info) ? info[1] : null;
        if (policy && policy !== 'noeviction') {
            throw new Error('Redis maxmemory-policy is "' + policy + '", but BullMQ needs "noeviction" or it can lose jobs. Set maxmemory-policy noeviction on the Redis server.');
        }
    } catch (err) {
        // Managed services such as Upstash do not allow CONFIG; they run noeviction themselves, so that case passes.
        if (err && /maxmemory-policy/.test(err.message)) throw err;
    } finally {
        await probe.quit();
    }

    const queueConnection = await connectRedis(ctx.env, { forQueue: true });
    const queue = new Queue(QUEUE_NAME, { connection: queueConnection, prefix });
    let worker = null;
    let workerConnection = null;
    let lastError = null;

    return {
        visibleDelayMs: 120000,

        async dispatch(eventId) {
            // A finished job with this id would make add() a no-op, so clear it before a replay or a redelivery.
            const existing = await queue.getJob(eventId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'completed' || state === 'failed') await existing.remove();
            }
            await queue.add('webhook', { event_id: eventId, site_id: ctx.config.siteId || 'default' }, {
                jobId: eventId,
                attempts: maxAttempts,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: { age: 3600, count: 1000 }
            });
            return { outcome: 'queued' };
        },

        async sweep(eventIds) {
            for (const id of eventIds) await this.dispatch(id);
        },

        async start() {
            if (!ctx.config.events.workerInProcess || worker) return;
            workerConnection = await connectRedis(ctx.env, { forQueue: true });
            worker = new Worker(QUEUE_NAME, async (job) => {
                const result = await ctx.processor.process(job.data.event_id);
                if (result.outcome === 'retry') throw new Error(result.error);
                if (result.outcome === 'failed') throw new UnrecoverableError(result.error);
                return result.outcome;
            }, { connection: workerConnection, prefix, concurrency: CONCURRENCY });
            worker.on('error', (err) => {
                lastError = err;
            });
            worker.on('ready', () => {
                lastError = null;
            });
        },

        async stop() {
            // close() waits for the jobs in hand to finish.
            if (worker) await worker.close();
            if (workerConnection) await workerConnection.quit();
            await queue.close();
            await queueConnection.quit();
            worker = null;
        },

        async ready() {
            try {
                return (await queueConnection.ping()) === 'PONG' && lastError === null;
            } catch {
                return false;
            }
        }
    };
}
