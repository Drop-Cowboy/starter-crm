/**
 * Runs one Async Workloads event: the webhook the core queued with `DC_WEBHOOKS=netlify-async`.
 *
 * Where it sits: `functions/webhook-jobs.mjs` passes each event here with the booted core. The work itself is the
 * core's: consume() reads the event from the store and runs its handlers
 * (server/node/src/providers/webhooks/netlify-async.js). What comes back tells Async Workloads what to do next.
 *
 * - A handler failure that deserves another attempt throws with the processor's backoff, and Async Workloads waits
 *   exactly that long (`forceDelayTime`).
 * - A boot failure is retried with the same backoff: an environment variable fixed and redeployed finishes the event.
 * - An event that reaches a deploy whose DC_WEBHOOKS names another mode is not retried; that mode re-queues its own
 *   events, and the maintenance run re-queues one whose message was lost.
 *
 * CONTRACT.md: "Webhook delivery".
 * What a customer changes: nothing.
 */

import { ErrorDoNotRetry, ErrorRetryAfterDelay } from '@netlify/async-workloads';

/**
 * @param {{ eventData: unknown, attempt: number }} event The Async Workloads event.
 * @param {{ ok: boolean, core?: object, config?: object }} booted What lib/core.js `core()` returned.
 * @param {(failures: number) => number} backoffMs The processor's backoff (server/node/src/processor.js).
 * @returns {Promise<void>} Resolves when the event is finished with; throws to have it retried or dropped.
 */
export async function runJob(event, booted, backoffMs) {
    if (!booted.ok) {
        throw new ErrorRetryAfterDelay({ message: 'The server is not configured. See the function log.', retryDelay: backoffMs(event.attempt + 1) });
    }
    const { dispatcher } = booted.core.runtime;
    if (typeof dispatcher.consume !== 'function') {
        throw new ErrorDoNotRetry('DC_WEBHOOKS is ' + booted.config.events.webhooks + ', not netlify-async.');
    }
    const result = await dispatcher.consume(event.eventData, event.attempt);
    if (result.outcome === 'retry') {
        throw new ErrorRetryAfterDelay({ message: result.error, retryDelay: result.retryAfterMs, forceDelayTime: true });
    }
}
