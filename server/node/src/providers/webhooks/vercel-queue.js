/**
 * The `vercel-queue` webhook mode: a Vercel Queues topic of event ids, consumed by a private route of this app.
 *
 * Where it sits: `DC_WEBHOOKS=vercel-queue`, the default on Vercel. The webhook records the event in the store, sends
 * a message to the topic and answers 200 only after Vercel Queues has accepted it. A message carries just the
 * `event_id` (and the site), never the contact's data. Vercel then calls `POST /internal/queue/webhook-jobs`, the
 * consumer route, which reads the event from the store and runs the handlers.
 *
 * - There is no worker: nothing runs between requests, which is what a serverless host needs. `start()` and `stop()`
 *   do nothing.
 * - When a handler fails and another attempt is due, the consumer fails the delivery with a retry delay equal to the
 *   backoff (1 s, 2 s, 4 s, up to 5 minutes), so Vercel hands the message out again at the right time.
 * - Delivery is at least once, so a message can arrive twice; the maintenance run (a daily cron on Vercel) re-queues
 *   events that were recorded but whose message was lost. Handlers must be idempotent, as for every webhook mode.
 * - The consumer route is wired to the topic in `vercel.json` (`queue/v2beta`) and Vercel keeps such routes private:
 *   only its queue can call it. Vercel Queues is a public beta, so `qstash` and `inline` are the documented fallbacks.
 *
 * Dispatcher interface: see store.js. `routes()` adds the consumer route to the core.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing), "Internal routes".
 * Env: VERCEL (set by Vercel), VERCEL_OIDC_TOKEN (set by Vercel, or by `vercel env pull` off Vercel). What a customer
 * changes: nothing.
 */

import { backoffMs } from '../../processor.js';
import { problem } from '../../problems.js';

export const name = 'vercel-queue';
export const configKeys = ['VERCEL', 'VERCEL_OIDC_TOKEN'];

/** The topic. `vercel.json` names the same one for the consumer route, and a trigger's topic cannot come from the environment. */
export const TOPIC = 'starter-crm-webhook-jobs';

/** Where Vercel delivers the topic's messages: the file `app/internal/queue/webhook-jobs/route.js` of the Next.js variant. */
export const CONSUMER_PATH = '/internal/queue/webhook-jobs';

/** How long Vercel leaves a message to its consumer before handing it out again, in seconds: the function's own limit. */
const VISIBILITY_SECONDS = 300;

/**
 * Checks the process can reach Vercel Queues.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const onVercel = typeof env.VERCEL === 'string' && env.VERCEL.trim() !== '';
    const token = typeof env.VERCEL_OIDC_TOKEN === 'string' && env.VERCEL_OIDC_TOKEN.trim() !== '';
    if (onVercel || token) return [];
    return [problem('vercel_queue_off_vercel', 'DC_WEBHOOKS=vercel-queue only works on Vercel, where the platform provides the credentials for the queue.',
        'Deploy to Vercel, or choose another DC_WEBHOOKS mode: qstash (Upstash) works on any host with a public address, bullmq needs Redis, store needs one machine.')];
}

/**
 * Seconds to wait before Vercel redelivers a message that failed.
 *
 * @param {number} deliveryCount How many times Vercel has delivered it, counting this one (at least 1).
 * @returns {number} Whole seconds, at least 1.
 */
export function retryAfterSeconds(deliveryCount) {
    return Math.max(1, Math.ceil(backoffMs(Math.max(1, deliveryCount)) / 1000));
}

/**
 * Loads the Vercel Queues SDK and returns the dispatcher.
 *
 * @param {{ config: object, processor: object, log: object,
 *   sdk?: { send: Function, handleCallback: Function } }} ctx Provider context; `sdk` replaces `@vercel/queue` in tests.
 * @returns {Promise<object>} The dispatcher, with `routes()` for the consumer.
 */
export async function create(ctx) {
    // The SDK is only needed when this mode is chosen, so it is not imported at the top of the file.
    const sdk = ctx.sdk || await import('@vercel/queue');
    const siteId = ctx.config.siteId || 'default';

    /**
     * Handles one delivery. Throwing is how a delivery is failed, so Vercel retries it.
     *
     * @param {unknown} message The payload the dispatcher sent.
     * @returns {Promise<void>}
     */
    async function consume(message) {
        const eventId = message && typeof message === 'object' && typeof message.event_id === 'string' ? message.event_id : '';
        if (eventId === '') {
            await ctx.log.warn('Dropping a queue message that is not an event id.');
            return;
        }
        const result = await ctx.processor.process(eventId);
        if (result.outcome === 'retry') throw new Error(result.error || 'A webhook handler failed.');
    }

    const consumer = sdk.handleCallback(consume, {
        visibilityTimeoutSeconds: VISIBILITY_SECONDS,
        retry: (_error, metadata) => ({ afterSeconds: retryAfterSeconds(metadata && metadata.deliveryCount) })
    });

    return {
        visibleDelayMs: 120000,

        async dispatch(eventId) {
            await sdk.send(TOPIC, { event_id: eventId, site_id: siteId });
            return { outcome: 'queued' };
        },

        async sweep(eventIds) {
            for (const id of eventIds) await this.dispatch(id);
        },

        routes() {
            return [{ method: 'POST', path: CONSUMER_PATH, handler: async (ctx2) => consumer(ctx2.request) }];
        },

        async start() {},

        async stop() {},

        async ready() {
            return true;
        }
    };
}
