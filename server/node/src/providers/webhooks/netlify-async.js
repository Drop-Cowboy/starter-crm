/**
 * The `netlify-async` webhook mode: Netlify Async Workloads runs each event id in a workload function of this site.
 *
 * Where it sits: `DC_WEBHOOKS=netlify-async`, the default on Netlify. The webhook records the event in the store, sends
 * the event `starter-crm-webhook-job` to the site's Async Workloads router and answers 200 only after the router has
 * accepted it. The event carries just the `event_id` (and the site), never the contact's data. Async Workloads then
 * runs the workload function (`server/netlify/functions/webhook-jobs.mjs`), which hands the event to `consume()` here:
 * it reads the event from the store and runs the handlers.
 *
 * - There is no worker: nothing runs between requests, which is what a serverless host needs. `start()` and `stop()`
 *   do nothing.
 * - Sending uses the router API Netlify documents for clients that cannot use its SDK: one `fetch` with the site's
 *   `AWL_API_KEY`. So the Node server needs no Netlify package; only the workload function imports
 *   `@netlify/async-workloads`, for the wrapper that receives events.
 * - The event goes to the address of the request being served, so a deploy preview's events run in that preview's
 *   workload against that preview's database. `DC_PUBLIC_URL` overrides it, and the site's main address (`URL`, set
 *   by Netlify) is the fallback when no request is in flight.
 * - When a handler fails and another attempt is due, `consume()` returns the backoff (1 s, 2 s, 4 s, up to 5 minutes)
 *   and the workload function asks Async Workloads to retry after exactly that long. The processor counts attempts
 *   against `DC_WEBHOOK_MAX_ATTEMPTS`, and the workload allows more retries than that setting's maximum, so the
 *   processor alone decides when an event has failed.
 * - Delivery is at least once, so an event can run twice; the maintenance run (a daily scheduled function) re-queues
 *   events that were recorded but whose message was lost. Handlers must be idempotent, as for every webhook mode.
 * - The router and the workload function both refuse a request without the key. On a Starter (free) team the key is
 *   set on the site; on paid teams the extension sets it on the team. Async Workloads is a Netlify extension, so
 *   `qstash` and `inline` are the documented fallbacks.
 *
 * Dispatcher interface: see store.js. There is no `routes()`: Async Workloads calls its own function, not the core.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing), "Internal routes".
 * Env: AWL_API_KEY or AWL_API_KEY_P<n> (set by the Async Workloads extension, or by you on a Starter team),
 * DC_PUBLIC_URL, URL and NETLIFY (set on Netlify). What a customer changes: nothing.
 */

import crypto from 'node:crypto';
import { backoffMs } from '../../processor.js';
import { problem } from '../../problems.js';

export const name = 'netlify-async';
export const configKeys = ['NETLIFY', 'URL', 'DC_PUBLIC_URL', 'AWL_API_KEY'];

/** The event name. `server/netlify/functions/webhook-jobs.mjs` subscribes to the same one. */
export const EVENT = 'starter-crm-webhook-job';

/** Where Async Workloads takes events on a site that has the extension. */
export const ROUTER_PATH = '/.netlify/functions/async-workloads-router';

/**
 * The router has to accept the event inside Drop Cowboy's 5-second acknowledgement window. A router that has gone
 * cold took about 2 s to accept one in October 2026, so this leaves it room and still leaves the webhook room to answer.
 */
const SEND_TIMEOUT_MS = 3000;

/** `AWL_API_KEY`, or `AWL_API_KEY_P<priority>`: the extension's naming for keys being rotated. */
const KEY_NAME = /^AWL_API_KEY(?:_P(\d+))?$/;

/**
 * The key to send: the one with the highest priority, as the extension itself picks.
 *
 * A plain `AWL_API_KEY` counts as priority 0, and `AWL_API_KEY_P0` wins over it.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {string} The key, or '' when none is set.
 */
export function apiKey(env) {
    let best = '';
    let bestRank = -1;
    for (const [key, raw] of Object.entries(env)) {
        const match = KEY_NAME.exec(key);
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!match || value === '') continue;
        // Doubled so a numbered key outranks the plain one at the same priority.
        const rank = match[1] === undefined ? 0 : Number(match[1]) * 2 + 1;
        if (rank > bestRank) {
            best = value;
            bestRank = rank;
        }
    }
    return best;
}

/**
 * The origin events are sent to.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @param {string|undefined} requestUrl The URL of the request being served, when there is one.
 * @returns {string} The origin without a trailing slash, or '' when none is known.
 */
export function routerOrigin(env, requestUrl) {
    const explicit = typeof env.DC_PUBLIC_URL === 'string' ? env.DC_PUBLIC_URL.trim() : '';
    if (explicit) return explicit.replace(/\/+$/, '');
    if (requestUrl) {
        try {
            return new URL(requestUrl).origin;
        } catch {
            // Not a URL; fall back to the site's main address.
        }
    }
    const main = typeof env.URL === 'string' ? env.URL.trim() : '';
    return main.replace(/\/+$/, '');
}

/**
 * Checks the process runs on Netlify and has the key the router asks for.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const onNetlify = typeof env.NETLIFY === 'string' && env.NETLIFY.trim() !== '';
    if (!onNetlify) {
        return [problem('netlify_async_off_netlify', 'DC_WEBHOOKS=netlify-async only works on Netlify, where Async Workloads runs the workload function.',
            'Deploy to Netlify, or choose another DC_WEBHOOKS mode: qstash (Upstash) works on any host with a public address, bullmq needs Redis, store needs one machine.')];
    }
    if (!apiKey(env)) {
        return [problem('missing_awl_api_key', 'DC_WEBHOOKS=netlify-async needs AWL_API_KEY, the key the Async Workloads router asks for.',
            'Install the Async Workloads extension for your team. On a Starter (free) team, also create a key for this site under Project configuration > '
            + 'Developer settings > Async Workloads. Then redeploy.')];
    }
    return [];
}

/**
 * Seconds to wait before Async Workloads runs a failed event again.
 *
 * @param {number} attempt Async Workloads' attempt number for the run that failed: 0 for the first.
 * @returns {number} Milliseconds, at least 1000.
 */
export function retryAfterMs(attempt) {
    const failures = Number.isInteger(attempt) && attempt >= 0 ? attempt + 1 : 1;
    return Math.max(1000, backoffMs(failures));
}

/**
 * Returns the dispatcher.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, processor: object, log: object, fetch?: typeof fetch,
 *   requestUrl?: () => string|undefined }} ctx Provider context. `fetch` and `requestUrl` replace the network and
 *   Netlify's per-request context in tests.
 * @returns {Promise<object>} The dispatcher, with `consume()` for the workload function.
 */
export async function create(ctx) {
    const fetchImpl = ctx.fetch || globalThis.fetch;
    const key = apiKey(ctx.env);
    const siteId = ctx.config.siteId || 'default';
    // Netlify exposes the request being served as `Netlify.context` inside a function invocation.
    const requestUrl = ctx.requestUrl || (() => globalThis.Netlify?.context?.url);

    return {
        visibleDelayMs: 120000,

        async dispatch(eventId) {
            const origin = routerOrigin(ctx.env, requestUrl());
            const response = await fetchImpl(origin + ROUTER_PATH + '?events=' + encodeURIComponent(EVENT), {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
                body: JSON.stringify({ eventName: EVENT, eventId: crypto.randomUUID(), data: { event_id: eventId, site_id: siteId } }),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
            });
            // Read the small body so the connection is released before the function is frozen.
            await response.text();
            if (!response.ok) {
                throw new Error('The Async Workloads router did not accept the event (HTTP ' + response.status + ').');
            }
            return { outcome: 'queued' };
        },

        async sweep(eventIds) {
            for (const id of eventIds) await this.dispatch(id);
        },

        /**
         * Runs one event the workload function received.
         *
         * @param {unknown} data The event's data, as sent by dispatch().
         * @param {number} attempt Async Workloads' attempt number: 0 for the first run.
         * @returns {Promise<{ outcome: string, error?: string, retryAfterMs?: number }>} `retry` with the delay when
         *   another attempt is due; anything else means the event needs no more runs.
         */
        async consume(data, attempt) {
            const eventId = data && typeof data === 'object' && typeof data.event_id === 'string' ? data.event_id : '';
            if (eventId === '') {
                await ctx.log.warn('Dropping an Async Workloads event that is not an event id.');
                return { outcome: 'ignored' };
            }
            const result = await ctx.processor.process(eventId);
            if (result.outcome === 'retry') {
                return { outcome: 'retry', error: result.error || 'A webhook handler failed.', retryAfterMs: retryAfterMs(attempt) };
            }
            return { outcome: result.outcome };
        },

        async start() {},

        async stop() {},

        async ready() {
            return true;
        }
    };
}
