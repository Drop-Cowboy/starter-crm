/**
 * The `sqs` webhook mode: an Amazon SQS queue of event ids, worked by this process (or by `npm run worker`).
 *
 * Where it sits: `DC_WEBHOOKS=sqs`, the default on AWS when `DC_STORE=dynamodb` and `DC_SQS_QUEUE_URL` is set. The
 * webhook records the event in the store, sends a message to the queue and answers 200 only after SQS has accepted
 * it. A message carries just the `event_id` (and the site), never the contact's data; the worker reads the event
 * from the store.
 *
 * - The worker long-polls the queue (20 seconds), runs the handlers for each message and deletes the message when
 *   the event is finished: `processed`, `failed` (attempts used up, kept in the store for `webhooks:replay`),
 *   `skipped` (already finished) or `missing`.
 * - When a handler fails and another attempt is due, the message stays and its visibility timeout is set to the
 *   backoff (1 s, 2 s, 4 s, up to 5 minutes), so SQS hands it out again at the right time.
 * - SQS delivers at least once, so a message can arrive twice, and the maintenance sweep re-queues events that were
 *   recorded but whose message was lost. Handlers must be idempotent, as for every webhook mode.
 * - The queue's own redrive policy (the CloudFormation template sets one) moves a message that keeps crashing the
 *   worker, which is not the same as a failing handler, to a dead-letter queue after `maxReceiveCount` receives.
 *   The event stays `received` in the store and the sweep queues it again.
 * - The queue's visibility timeout must be longer than your slowest handler, or SQS hands the message to a second
 *   worker while the first is still running.
 *
 * Dispatcher interface: see store.js.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
 * Env: DC_SQS_QUEUE_URL, AWS_REGION, DC_WORKER_IN_PROCESS. What a customer changes: nothing.
 */

import { clientConfig, validateAws } from '../../aws.js';
import { problem } from '../../problems.js';
import { backoffMs } from '../../processor.js';
import { allowsPlaintext } from '../../tls.js';

export const name = 'sqs';
export const configKeys = ['DC_SQS_QUEUE_URL', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_SQS', 'DC_WORKER_IN_PROCESS'];

/** Messages handled at once per worker. Handlers are I/O-bound. */
const CONCURRENCY = 5;

/** SQS's longest long poll, in seconds. */
const WAIT_SECONDS = 20;

/** SQS's longest visibility timeout: 12 hours. */
const MAX_VISIBILITY_SECONDS = 43200;

/** How long the worker rests after a receive fails, so an outage is not a busy loop. */
const ERROR_REST_MS = 3000;

/** Hosts a plain-HTTP queue address is accepted on in production: this machine only. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Checks the queue address and the region.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = validateAws(env, 'DC_WEBHOOKS=sqs', 'SQS');
    const raw = typeof env.DC_SQS_QUEUE_URL === 'string' ? env.DC_SQS_QUEUE_URL.trim() : '';
    if (raw === '') {
        problems.push(problem('missing_sqs_queue_url', 'DC_WEBHOOKS=sqs needs DC_SQS_QUEUE_URL.',
            'Set DC_SQS_QUEUE_URL to the queue\'s URL (the CloudFormation template outputs it), or choose another DC_WEBHOOKS mode.'));
        return problems;
    }
    let url = null;
    try {
        url = new URL(raw);
    } catch {
        problems.push(problem('invalid_sqs_queue_url', 'DC_SQS_QUEUE_URL is not a URL (got "' + raw + '").',
            'Set it to the queue\'s URL: the WebhookQueueUrl output of the CloudFormation template, or the URL shown for the queue in the AWS console.'));
    }
    if (url && env.DC_ENV === 'production' && url.protocol !== 'https:' && !LOCAL_HOSTS.includes(url.hostname) && !allowsPlaintext(env)) {
        problems.push(problem('insecure_sqs_queue_url', 'DC_SQS_QUEUE_URL must use https:// in production.',
            'Use the queue\'s https:// URL. Localhost is exempt, and so is a private network you control when DC_INSECURE_PRIVATE_SERVICES=on.'));
    }
    return problems;
}

/**
 * Connects and checks the queue is there, then returns the dispatcher.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, store: object, processor: object, log: object,
 *   client?: { send: Function, destroy?: Function }, waitSeconds?: number }} ctx Provider context; `client` and
 *   `waitSeconds` (the long-poll length) are replaced in tests.
 * @returns {Promise<object>} The dispatcher.
 * @throws {Error} When the queue could not be read, naming the address.
 */
export async function create(ctx) {
    // The SDK is only needed when this mode is chosen, so it is not imported at the top of the file.
    const sdk = await import('@aws-sdk/client-sqs');
    const client = ctx.client || new sdk.SQSClient(clientConfig(ctx.env, 'SQS'));
    const queueUrl = ctx.env.DC_SQS_QUEUE_URL.trim();
    const siteId = ctx.config.siteId || 'default';
    const waitSeconds = ctx.waitSeconds === undefined ? WAIT_SECONDS : ctx.waitSeconds;
    let running = false;
    let loop = null;
    let controller = null;
    let lastError = null;
    let rest = null;

    try {
        await client.send(new sdk.GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
    } catch (err) {
        throw new Error('Cannot read the SQS queue ' + queueUrl + ': ' + (err && err.name ? err.name : 'error') + (err && err.message ? ' (' + err.message + ')' : ''), { cause: err });
    }

    /**
     * Handles one message and settles it with SQS.
     *
     * @param {{ MessageId: string, ReceiptHandle: string, Body: string, Attributes?: Record<string, string> }} message The message.
     * @returns {Promise<void>}
     */
    async function handle(message) {
        let eventId = null;
        try {
            const body = JSON.parse(message.Body);
            if (body && typeof body.event_id === 'string' && body.event_id !== '') eventId = body.event_id;
        } catch {
            // Falls through to the poison-message branch below.
        }
        if (eventId === null) {
            await ctx.log.warn('Dropping an SQS message that is not an event id: ' + message.MessageId);
            await client.send(new sdk.DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
            return;
        }
        const result = await ctx.processor.process(eventId);
        if (result.outcome === 'retry') {
            const received = Number(message.Attributes && message.Attributes.ApproximateReceiveCount) || 1;
            const seconds = Math.min(MAX_VISIBILITY_SECONDS, Math.max(1, Math.ceil(backoffMs(received) / 1000)));
            await client.send(new sdk.ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }));
            return;
        }
        await client.send(new sdk.DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }

    /**
     * Sleeps, unless the worker is stopped first.
     *
     * @param {number} ms How long.
     * @returns {Promise<void>}
     */
    function pause(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            rest = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }

    /**
     * The worker: receives a batch, handles it, and goes again until stopped. A message that crashes the handler
     * code (not a handler that throws, which `process()` reports as `retry`) is left alone, so SQS redelivers it.
     *
     * @returns {Promise<void>}
     */
    async function work() {
        while (running) {
            let messages;
            try {
                const received = await client.send(new sdk.ReceiveMessageCommand({
                    QueueUrl: queueUrl, MaxNumberOfMessages: CONCURRENCY, WaitTimeSeconds: waitSeconds, MessageSystemAttributeNames: ['ApproximateReceiveCount']
                }), { abortSignal: controller.signal });
                messages = received.Messages || [];
                lastError = null;
            } catch (err) {
                if (!running) return;
                lastError = err;
                await ctx.log.warn('SQS receive failed: ' + (err && err.message ? err.message : 'unknown error'));
                await pause(ERROR_REST_MS);
                continue;
            }
            // Every message in the batch finishes before the next receive, so a stop waits for the work in hand.
            await Promise.all(messages.map(async (message) => {
                try {
                    await handle(message);
                } catch (err) {
                    await ctx.log.error('SQS message ' + message.MessageId + ' could not be settled; SQS will deliver it again:', err && err.message ? err.message : 'unknown error');
                }
            }));
        }
    }

    return {
        visibleDelayMs: 120000,

        async dispatch(eventId) {
            await client.send(new sdk.SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ event_id: eventId, site_id: siteId }) }));
            return { outcome: 'queued' };
        },

        async sweep(eventIds) {
            for (const id of eventIds) await this.dispatch(id);
        },

        async start() {
            if (!ctx.config.events.workerInProcess || running) return;
            running = true;
            controller = new AbortController();
            loop = work();
        },

        async stop() {
            if (running) {
                running = false;
                // Ends the long poll in flight; a message already received is still handled and settled.
                controller.abort();
                if (rest) rest();
                await loop;
                loop = null;
            }
            if (!ctx.client && typeof client.destroy === 'function') client.destroy();
        },

        async ready() {
            if (lastError !== null) return false;
            try {
                await client.send(new sdk.GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
                return true;
            } catch {
                return false;
            }
        }
    };
}
