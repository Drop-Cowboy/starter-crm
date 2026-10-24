/**
 * The `qstash` webhook mode: Upstash QStash delivers each event id back to this server.
 *
 * Where it sits: `DC_WEBHOOKS=qstash`, the tested fallback when Vercel Queues is not an option and the queue for any
 * host with a public address. The webhook records the event in the store, publishes a message to QStash and answers
 * 200 only after QStash has accepted it. A message carries just the `event_id` (and the site), never the contact's
 * data. QStash then calls `POST /internal/webhook-jobs` on this server, which verifies QStash's signature, reads the
 * event from the store and runs the handlers.
 *
 * - There is no worker: nothing runs between requests, so it suits serverless hosts. `start()` and `stop()` do
 *   nothing.
 * - The route runs nothing before it has verified the `Upstash-Signature` header against the current and the next
 *   signing key (so a key rotation never drops a message), the body hash and the destination URL. Anything else is
 *   401.
 * - When a handler fails and another attempt is due, the route answers 503 and QStash retries after the backoff the
 *   publish asked for (1 s, 2 s, 4 s, up to 5 minutes). QStash gives up after its own retry limit (3 on the free
 *   plan); the event then stays `received`, and the maintenance run re-queues it.
 * - Delivery is at least once, so handlers must be idempotent, as for every webhook mode.
 *
 * Dispatcher interface: see store.js. `routes()` adds the internal route to the core.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing), "Internal routes".
 * Env: QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, QSTASH_URL, DC_PUBLIC_URL (on Vercel and
 * Netlify the site's own address is the default). What a customer changes: nothing.
 */

import { HttpError } from '../../errors.js';
import { jsonResponse, readBody } from '../../http.js';
import { problem } from '../../problems.js';

export const name = 'qstash';
export const configKeys = ['QSTASH_TOKEN', 'QSTASH_URL', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'DC_PUBLIC_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'NETLIFY', 'URL'];

/** The route QStash calls. */
export const JOBS_PATH = '/internal/webhook-jobs';

/** QStash waits this long between retries: 1 s, 2 s, 4 s, up to 5 minutes, like every other mode. */
const RETRY_DELAY = 'min(300000, pow(2, retried) * 1000)';

/**
 * A trimmed variable, treating blank as unset.
 *
 * @param {NodeJS.ProcessEnv} env The environment.
 * @param {string} key The variable.
 * @returns {string} The value, or ''.
 */
function read(env, key) {
    return typeof env[key] === 'string' ? env[key].trim() : '';
}

/**
 * The public origin QStash calls: `DC_PUBLIC_URL`, or the site's main address on Vercel or Netlify.
 *
 * `URL` is a common name for unrelated settings, so it is only read when `NETLIFY` says Netlify set it.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {string} The origin without a trailing slash, or '' when none is set.
 */
export function publicOrigin(env) {
    const explicit = read(env, 'DC_PUBLIC_URL');
    if (explicit) return explicit.replace(/\/+$/, '');
    const vercel = read(env, 'VERCEL_PROJECT_PRODUCTION_URL');
    if (vercel) return 'https://' + vercel;
    return read(env, 'NETLIFY') ? read(env, 'URL').replace(/\/+$/, '') : '';
}

/**
 * Checks the token, both signing keys and the public address.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = [];
    const where = 'Copy it from the QStash page of the Upstash console (the Vercel integration sets it for you).';
    for (const key of ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY']) {
        if (!read(env, key)) {
            problems.push(problem('missing_qstash_setting', 'DC_WEBHOOKS=qstash needs ' + key + '.', 'Set ' + key + '. ' + where));
        }
    }
    const origin = publicOrigin(env);
    if (!origin) {
        problems.push(problem('missing_qstash_public_url', 'DC_WEBHOOKS=qstash needs DC_PUBLIC_URL: QStash has to know where to send each event.',
            'Set DC_PUBLIC_URL to your site\'s public origin, for example https://crm.example.com.'));
    } else {
        let url = null;
        try {
            url = new URL(origin);
        } catch {
            problems.push(problem('invalid_qstash_public_url', 'DC_PUBLIC_URL is not a URL (got "' + origin + '").',
                'Set DC_PUBLIC_URL to your site\'s public origin, for example https://crm.example.com.'));
        }
        if (url && env.DC_ENV === 'production' && url.protocol !== 'https:') {
            problems.push(problem('insecure_qstash_public_url', 'DC_PUBLIC_URL must use https:// in production, because QStash sends your events there.',
                'Use the https:// address of your site.'));
        }
    }
    const base = read(env, 'QSTASH_URL');
    if (base) {
        try {
            new URL(base);
        } catch {
            problems.push(problem('invalid_qstash_url', 'QSTASH_URL is not a URL (got "' + base + '").',
                'Unset it for the default region, or set the regional address from the Upstash console.'));
        }
    }
    return problems;
}

/**
 * Loads the QStash SDK and returns the dispatcher.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, processor: object, log: object,
 *   sdk?: { Client: Function, Receiver: Function } }} ctx Provider context; `sdk` replaces `@upstash/qstash` in tests.
 * @returns {Promise<object>} The dispatcher, with `routes()` for the signed internal route.
 */
export async function create(ctx) {
    // The SDK is only needed when this mode is chosen, so it is not imported at the top of the file.
    const sdk = ctx.sdk || await import('@upstash/qstash');
    const token = read(ctx.env, 'QSTASH_TOKEN');
    const baseUrl = read(ctx.env, 'QSTASH_URL');
    const client = new sdk.Client(baseUrl ? { token, baseUrl } : { token });
    const receiver = new sdk.Receiver({
        currentSigningKey: read(ctx.env, 'QSTASH_CURRENT_SIGNING_KEY'),
        nextSigningKey: read(ctx.env, 'QSTASH_NEXT_SIGNING_KEY')
    });
    const destination = publicOrigin(ctx.env) + JOBS_PATH;
    const siteId = ctx.config.siteId || 'default';

    /**
     * Whether QStash signed this request for this destination.
     *
     * @param {Request} request The incoming request.
     * @param {Buffer} raw The exact body bytes.
     * @returns {Promise<boolean>} True only for a valid, current signature.
     */
    async function verified(request, raw) {
        const signature = request.headers.get('upstash-signature');
        if (!signature) return false;
        try {
            const region = request.headers.get('upstash-region');
            return (await receiver.verify({ signature, body: raw.toString('utf8'), url: destination, ...(region ? { upstashRegion: region } : {}) })) === true;
        } catch {
            return false;
        }
    }

    /**
     * The route QStash calls: verify, then run the event's handlers.
     *
     * @param {object} route The request context.
     * @returns {Promise<Response>} 200 when the event is finished, 503 when QStash should retry.
     * @throws {HttpError} 401 `invalid_signature`, 413 `payload_too_large`.
     */
    async function jobs(route) {
        const raw = await readBody(route.request);
        if (!(await verified(route.request, raw))) {
            await route.log.warn('Rejected a QStash call with a missing or invalid signature.');
            throw new HttpError(401, 'invalid_signature', 'The Upstash-Signature header is missing or does not match the signing keys.');
        }
        let eventId = '';
        try {
            const body = JSON.parse(raw.toString('utf8'));
            if (body && typeof body.event_id === 'string') eventId = body.event_id;
        } catch {
            // Falls through to the poison-message branch below.
        }
        if (eventId === '') {
            // Only this server publishes here, so this never retries into success: drop it.
            await route.log.warn('Dropping a QStash message that is not an event id.');
            return jsonResponse(200, { ignored: true });
        }
        const result = await ctx.processor.process(eventId);
        if (result.outcome === 'retry') {
            throw new HttpError(503, 'handler_failed', 'A webhook handler failed. QStash will retry.');
        }
        return jsonResponse(200, { outcome: result.outcome });
    }

    return {
        visibleDelayMs: 120000,

        async dispatch(eventId) {
            await client.publishJSON({ url: destination, body: { event_id: eventId, site_id: siteId }, retryDelay: RETRY_DELAY });
            return { outcome: 'queued' };
        },

        async sweep(eventIds) {
            for (const id of eventIds) await this.dispatch(id);
        },

        routes() {
            return [{ method: 'POST', path: JOBS_PATH, handler: jobs }];
        },

        async start() {},

        async stop() {},

        async ready() {
            return true;
        }
    };
}
