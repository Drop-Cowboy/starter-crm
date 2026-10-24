/**
 * Webhook intake: verifies Drop Cowboy's signature on the raw body, records the
 * event, and queues its handlers.
 *
 * Where it sits: Drop Cowboy -> `POST /webhooks/dropcowboy` -> this file -> event
 * store -> webhook mode (outbox, BullMQ or inline) -> processor -> fan-out -> SSE
 * `/api/events` -> browser.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy".
 * What a customer changes: nothing here; write handlers (handlers.js) to act on events.
 */

import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { jsonResponse, readBody } from './http.js';

/** Clock drift allowed on X-Timestamp: 5 minutes, which absorbs ordinary skew but limits how long a captured request can be replayed. */
export const TOLERANCE_SECONDS = 300;

// Drop Cowboy signs `${X-Timestamp}.${body}` with HMAC-SHA256 and the
// webhook's signing secret, and sends `sha256=<hex>` in X-Signature.
// This must run on the exact bytes received: parsing the JSON and serialising
// it again changes spacing or key order, and then nothing verifies.
//
// Each webhook has its own secret, so a delivery is
// valid if any configured secret matches.
/**
 * Checks a webhook delivery's signature.
 *
 * @param {object} input The pieces of the delivery.
 * @param {Buffer} input.rawBody The exact bytes received.
 * @param {string} [input.signature] The `X-Signature` header (`sha256=<hex>`).
 * @param {string} [input.timestamp] The `X-Timestamp` header, epoch seconds.
 * @param {string} [input.version] The `X-Signature-Version` header; only `v1` is understood.
 * @param {string[]} input.secrets Every configured signing secret; any one may match.
 * @param {number} input.nowSeconds Current time in epoch seconds, passed in for tests.
 * @returns {{ ok: true } | { ok: false, code: string, message: string }} The verdict; codes are
 *   `missing_signature`, `invalid_signature` and `stale_timestamp`.
 */
export function verifySignature({ rawBody, signature, timestamp, version, secrets, nowSeconds }) {
    if (!signature || !timestamp) {
        return fail('missing_signature', 'X-Signature and X-Timestamp headers are required.');
    }
    if (version && version !== 'v1') {
        return fail('invalid_signature', 'Unsupported X-Signature-Version "' + version + '".');
    }
    if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
        return fail('stale_timestamp', 'X-Timestamp is missing, malformed or more than 5 minutes from now.');
    }

    const received = Buffer.from(signature);
    for (const secret of secrets) {
        const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret)
            .update(timestamp + '.')
            .update(rawBody)
            .digest('hex'));
        if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
            return { ok: true };
        }
    }
    return fail('invalid_signature', 'Signature does not match. Check DROPCOWBOY_WEBHOOK_SECRET.');
}

/**
 * Builds the `POST /webhooks/dropcowboy` handler.
 *
 * The order is fixed, and it is what makes delivery safe:
 * 1. Verify the signature on the raw body.
 * 2. `await store.record()`: the event is stored before anything else happens.
 * 3. `await dispatcher.dispatch()`: queue the event id, or run the handlers inline.
 * 4. Answer 2xx.
 * If step 3 fails the answer is 503 and the event stays `received`, so Drop Cowboy's
 * retry (or the maintenance sweep) picks it up. An event is never acknowledged unless
 * it is both stored and queued.
 *
 * A repeat of an event id (Drop Cowboy retries with the same one) answers
 * `{ received: true, duplicate: true }`. If the earlier copy never finished (still
 * `received`), its handlers are queued again; that is at-least-once delivery, so handlers
 * must be idempotent (handlers.js).
 *
 * Side effects: records the event, queues or runs its handlers, and calls the observer's
 * `onWebhook` hook. Logs through the request's own logger, `ctx.log`.
 *
 * @param {object} config Validated config (webhookSecrets).
 * @param {{ store: { record: Function }, dispatcher: { dispatch: Function, visibleDelayMs?: number } }} deps
 *   The event store and the webhook mode.
 * @returns {(ctx: object) => Promise<Response>} Handler answering `{ received: true }`.
 * @throws {HttpError} 503 `webhook_not_configured`, `event_store_unavailable`, `webhook_not_queued` or `handler_failed`,
 *   401 for a bad signature, 400 `invalid_json`, 413 `payload_too_large`.
 */
export function webhookRoute(config, { store, dispatcher }) {
    /**
     * Queues an event's handlers and turns a failure into the 503 that makes Drop Cowboy retry.
     *
     * @param {string} eventId The recorded event.
     * @param {object} ctx The request context, for its logger.
     * @returns {Promise<void>}
     * @throws {HttpError} 503 when the event could not be queued, or an inline handler failed.
     */
    async function dispatch(eventId, ctx) {
        let result;
        try {
            result = await dispatcher.dispatch(eventId);
        } catch (err) {
            await ctx.log.error('Could not queue event ' + eventId + ':', err.message);
            throw new HttpError(503, 'webhook_not_queued', 'The event was stored but could not be queued. Drop Cowboy will retry.');
        }
        if (result.outcome === 'retry') {
            throw new HttpError(503, 'handler_failed', 'A webhook handler failed. Drop Cowboy will retry.');
        }
    }

    return async function receiveWebhook(ctx) {
        // Read first, so a body over 1 MB is 413 whatever else is wrong. These
        // are the exact bytes Drop Cowboy signed: no parser may touch them.
        const rawBody = await readBody(ctx.request);
        if (config.webhookSecrets.length === 0) {
            throw new HttpError(503, 'webhook_not_configured', 'Set DROPCOWBOY_WEBHOOK_SECRET to receive webhooks.');
        }

        const header = (name) => ctx.request.headers.get(name) || undefined;
        const check = verifySignature({
            rawBody,
            signature: header('x-signature'),
            timestamp: header('x-timestamp'),
            version: header('x-signature-version'),
            secrets: config.webhookSecrets,
            nowSeconds: Math.floor(Date.now() / 1000)
        });
        if (!check.ok) {
            await ctx.log.warn('Rejected webhook:', check.code);
            throw new HttpError(401, check.code, check.message);
        }

        const body = parseObject(rawBody.toString('utf8'));
        if (!body) {
            throw new HttpError(400, 'invalid_json', 'Webhook body is not a JSON object.');
        }

        const eventId = header('x-event-id') || (typeof body.event_id === 'string' ? body.event_id : null) || crypto.randomUUID();
        const eventName = typeof body.event === 'string' ? body.event : null;
        const attempt = Number.parseInt(header('x-attempt'), 10);
        let recorded;
        try {
            recorded = await store.record({
                event_id: eventId,
                event: eventName,
                event_at: typeof body.event_at === 'number' ? body.event_at : null,
                received_at: Date.now(),
                attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
                data: body.data !== null && typeof body.data === 'object' ? body.data : {}
            }, { visibleAt: Date.now() + (dispatcher.visibleDelayMs || 0) });
        } catch (err) {
            await ctx.log.error('Could not store event ' + eventId + ':', err.message);
            throw new HttpError(503, 'event_store_unavailable', 'The event could not be stored. Drop Cowboy will retry.');
        }

        if (!recorded.inserted) {
            // A copy that never finished gets its handlers queued again; a finished one is just acknowledged.
            if (recorded.status === 'received') await dispatch(eventId, ctx);
            await ctx.hooks.onWebhook({ request_id: ctx.requestId, event_id: eventId, event: eventName, duplicate: true });
            return jsonResponse(200, { received: true, duplicate: true });
        }

        await dispatch(eventId, ctx);
        await ctx.log.info('Webhook', body.event || '(no event type)', eventId);
        await ctx.hooks.onWebhook({ request_id: ctx.requestId, event_id: eventId, event: eventName, duplicate: false });
        return jsonResponse(200, { received: true });
    };
}

/**
 * `GET /api/webhooks/status`: how webhook handling is doing, for the Setup page and `doctor`.
 *
 * @param {object} config Validated config (events.store, events.webhooks).
 * @param {{ store: { counts: Function } }} deps The event store.
 * @returns {(ctx: object) => Promise<Response>} Handler answering the counts of events by state.
 * @throws {HttpError} 503 `event_store_unavailable` when the store cannot be read.
 */
export function webhookStatusRoute(config, { store }) {
    return async function webhookStatus(ctx) {
        let counts;
        try {
            counts = await store.counts();
        } catch (err) {
            await ctx.log.error('Could not read event counts:', err.message);
            throw new HttpError(503, 'event_store_unavailable', 'The event store could not be read.');
        }
        return jsonResponse(200, {
            store: config.events.store,
            webhooks: config.events.webhooks,
            max_attempts: config.events.maxAttempts,
            received: counts.received,
            processed: counts.processed,
            failed: counts.failed,
            oldest_received_age_seconds: counts.oldest_received_age_seconds
        });
    };
}

function fail(code, message) {
    return { ok: false, code, message };
}

function parseObject(text) {
    try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}
