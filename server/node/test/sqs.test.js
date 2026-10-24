// The `sqs` webhook mode against ElasticMQ (tests/services.compose.yml), the SQS-compatible stand-in. The suites skip,
// with a notice, when it is not running. The dispatcher is driven with a fake processor so each outcome is exact.
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as sqs from '../src/providers/webhooks/sqs.js';
import { HAVE_SQS, SQS_URL, awsTestEnv } from './services.js';

const SQS_SDK = await import('@aws-sdk/client-sqs');
const admin = new SQS_SDK.SQSClient({ region: 'us-east-1', endpoint: SQS_URL, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

/** ElasticMQ answers with its own in-container address, so the URL a host test uses is built from the endpoint. */
const urlOf = (name) => SQS_URL + '/000000000000/' + name;

async function makeQueue(attributes = {}) {
    const name = 'webhooks-' + crypto.randomUUID();
    await admin.send(new SQS_SDK.CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: '1', ...attributes } }));
    return name;
}

async function depth(name) {
    const result = await admin.send(new SQS_SDK.GetQueueAttributesCommand({ QueueUrl: urlOf(name), AttributeNames: ['All'] }));
    const a = result.Attributes;
    return Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible) + Number(a.ApproximateNumberOfMessagesDelayed);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return true;
        await wait(50);
    }
    return false;
}

const warnings = [];
const log = { warn: async (...args) => warnings.push(args.join(' ')), error: async (...args) => warnings.push(args.join(' ')), info: async () => {} };
const opened = [];

async function dispatcher(queue, processor, { workerInProcess = true, waitSeconds = 1 } = {}) {
    const ctx = {
        config: { siteId: 'site-a', events: { workerInProcess, maxAttempts: 5 } },
        env: awsTestEnv({ DC_SQS_QUEUE_URL: urlOf(queue) }),
        store: {}, processor, log, waitSeconds
    };
    const d = await sqs.create(ctx);
    opened.push(d);
    return d;
}

afterEach(async () => {
    while (opened.length) await opened.pop().stop();
    warnings.length = 0;
});

describe.skipIf(!HAVE_SQS)('webhooks: sqs', () => {
    it('sends the event id, never contact data, and a worker processes it and deletes the message', async () => {
        const queue = await makeQueue();
        const seen = [];
        const d = await dispatcher(queue, { process: async (id) => { seen.push(id); return { outcome: 'processed' }; } });
        await d.start();
        const id = crypto.randomUUID();
        expect(await d.dispatch(id)).toEqual({ outcome: 'queued' });
        expect(await until(() => seen.length === 1)).toBe(true);
        expect(seen).toEqual([id]);
        expect(await until(async () => (await depth(queue)) === 0)).toBe(true);
    });

    it('puts only the event id and the site on the queue', async () => {
        const queue = await makeQueue();
        const d = await dispatcher(queue, { process: async () => ({ outcome: 'processed' }) }, { workerInProcess: false });
        const id = crypto.randomUUID();
        await d.dispatch(id);
        const got = await admin.send(new SQS_SDK.ReceiveMessageCommand({ QueueUrl: urlOf(queue), WaitTimeSeconds: 2 }));
        expect(JSON.parse(got.Messages[0].Body)).toEqual({ event_id: id, site_id: 'site-a' });
    });

    it('leaves the queue alone when workers are off', async () => {
        const queue = await makeQueue();
        const seen = [];
        const d = await dispatcher(queue, { process: async (id) => { seen.push(id); return { outcome: 'processed' }; } }, { workerInProcess: false });
        await d.start();
        await d.dispatch(crypto.randomUUID());
        await wait(1500);
        expect(seen).toEqual([]);
        expect(await depth(queue)).toBe(1);
    });

    it('keeps the message for the backoff after a retry, then processes it again', async () => {
        const queue = await makeQueue({ VisibilityTimeout: '30' });
        const times = [];
        const d = await dispatcher(queue, {
            process: async () => {
                times.push(Date.now());
                return times.length === 1 ? { outcome: 'retry', error: 'handler failed' } : { outcome: 'processed' };
            }
        });
        await d.start();
        await d.dispatch(crypto.randomUUID());
        expect(await until(() => times.length === 2, 10000)).toBe(true);
        // The first backoff is one second; the queue's own timeout is 30, so only the backoff can explain this gap.
        expect(times[1] - times[0]).toBeGreaterThanOrEqual(900);
        expect(times[1] - times[0]).toBeLessThan(5000);
        expect(await until(async () => (await depth(queue)) === 0)).toBe(true);
    });

    it('deletes the message for an event that failed for good, was skipped or is missing', async () => {
        const queue = await makeQueue();
        const outcomes = ['failed', 'skipped', 'missing'];
        let calls = 0;
        const d = await dispatcher(queue, { process: async () => ({ outcome: outcomes[calls++] }) });
        await d.start();
        for (let i = 0; i < 3; i++) await d.dispatch(crypto.randomUUID());
        expect(await until(() => calls === 3)).toBe(true);
        expect(await until(async () => (await depth(queue)) === 0)).toBe(true);
        await wait(1500);
        expect(calls).toBe(3);
    });

    it('leaves a message that crashes the processor, so SQS delivers it again', async () => {
        const queue = await makeQueue();
        let calls = 0;
        const d = await dispatcher(queue, {
            process: async () => {
                calls += 1;
                if (calls === 1) throw new Error('store is down');
                return { outcome: 'processed' };
            }
        });
        await d.start();
        await d.dispatch(crypto.randomUUID());
        expect(await until(() => calls === 2, 10000)).toBe(true);
        expect(warnings.some((w) => /store is down/.test(w))).toBe(true);
        expect(await until(async () => (await depth(queue)) === 0)).toBe(true);
    });

    it('drops a message that is not an event id', async () => {
        const queue = await makeQueue();
        let calls = 0;
        const d = await dispatcher(queue, { process: async () => { calls += 1; return { outcome: 'processed' }; } });
        await d.start();
        await admin.send(new SQS_SDK.SendMessageCommand({ QueueUrl: urlOf(queue), MessageBody: 'not json' }));
        await admin.send(new SQS_SDK.SendMessageCommand({ QueueUrl: urlOf(queue), MessageBody: JSON.stringify({ event_id: 7 }) }));
        expect(await until(async () => (await depth(queue)) === 0)).toBe(true);
        expect(calls).toBe(0);
        expect(warnings.some((w) => /not an event id/.test(w))).toBe(true);
    });

    it('lets the queue\'s redrive policy move a message that keeps crashing the worker to the dead-letter queue', async () => {
        const dead = await makeQueue();
        const deadArn = (await admin.send(new SQS_SDK.GetQueueAttributesCommand({ QueueUrl: urlOf(dead), AttributeNames: ['QueueArn'] }))).Attributes.QueueArn;
        const queue = await makeQueue({ RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadArn, maxReceiveCount: 2 }) });
        let calls = 0;
        const d = await dispatcher(queue, { process: async () => { calls += 1; throw new Error('always crashes'); } });
        await d.start();
        const id = crypto.randomUUID();
        await d.dispatch(id);
        expect(await until(async () => (await depth(dead)) === 1, 15000)).toBe(true);
        expect(calls).toBe(2);
        await d.stop();
        const got = await admin.send(new SQS_SDK.ReceiveMessageCommand({ QueueUrl: urlOf(dead), WaitTimeSeconds: 2 }));
        expect(JSON.parse(got.Messages[0].Body).event_id).toBe(id);
    });

    it('re-queues every event a sweep names', async () => {
        const queue = await makeQueue();
        const seen = new Set();
        const d = await dispatcher(queue, { process: async (id) => { seen.add(id); return { outcome: 'processed' }; } });
        await d.start();
        const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
        await d.sweep(ids);
        expect(await until(() => seen.size === 3)).toBe(true);
    });

    it('handles several messages at once', async () => {
        const queue = await makeQueue();
        let running = 0;
        let peak = 0;
        let done = 0;
        const d = await dispatcher(queue, {
            process: async () => {
                running += 1;
                peak = Math.max(peak, running);
                await wait(300);
                running -= 1;
                done += 1;
                return { outcome: 'processed' };
            }
        });
        await d.sweep(Array.from({ length: 5 }, () => crypto.randomUUID()));
        await d.start();
        expect(await until(() => done === 5)).toBe(true);
        expect(peak).toBeGreaterThan(1);
    });

    it('stops promptly during a long poll, and finishes the message in hand first', async () => {
        const queue = await makeQueue();
        const idle = await dispatcher(queue, { process: async () => ({ outcome: 'processed' }) }, { waitSeconds: 20 });
        await idle.start();
        await wait(300);
        const began = Date.now();
        await idle.stop();
        expect(Date.now() - began).toBeLessThan(2000);

        const busyQueue = await makeQueue();
        let finished = false;
        const busy = await dispatcher(busyQueue, { process: async () => { await wait(600); finished = true; return { outcome: 'processed' }; } }, { waitSeconds: 20 });
        await busy.dispatch(crypto.randomUUID());
        await busy.start();
        await wait(300);
        await busy.stop();
        expect(finished).toBe(true);
        expect(await depth(busyQueue)).toBe(0);
    });

    it('reports ready while the queue answers, and not after a receive fails', async () => {
        const queue = await makeQueue();
        const d = await dispatcher(queue, { process: async () => ({ outcome: 'processed' }) });
        expect(await d.ready()).toBe(true);
        await admin.send(new SQS_SDK.DeleteQueueCommand({ QueueUrl: urlOf(queue) }));
        expect(await d.ready()).toBe(false);
    });

    it('refuses to start when the queue does not exist, naming its address', async () => {
        const missing = 'missing-' + crypto.randomUUID();
        await expect(dispatcher(missing, { process: async () => ({ outcome: 'processed' }) })).rejects.toThrow(missing);
    });
});

describe('webhooks: sqs settings', () => {
    it('needs a queue URL and a region', () => {
        expect(sqs.validate({ AWS_REGION: 'us-east-1' }).map((p) => p.code)).toEqual(['missing_sqs_queue_url']);
        expect(sqs.validate({ DC_SQS_QUEUE_URL: 'https://queue.example.test/q' }).map((p) => p.code)).toEqual(['missing_aws_region']);
        expect(sqs.validate({ AWS_REGION: 'us-east-1', DC_SQS_QUEUE_URL: 'https://queue.example.test/q' })).toEqual([]);
    });

    it('rejects a queue URL that is not a URL, and plain http in production off this machine', () => {
        expect(sqs.validate({ AWS_REGION: 'r', DC_SQS_QUEUE_URL: 'queue' }).map((p) => p.code)).toEqual(['invalid_sqs_queue_url']);
        const env = { AWS_REGION: 'r', DC_ENV: 'production' };
        expect(sqs.validate({ ...env, DC_SQS_QUEUE_URL: 'http://queue.example.com/1/q' }).map((p) => p.code)).toEqual(['insecure_sqs_queue_url']);
        expect(sqs.validate({ ...env, DC_SQS_QUEUE_URL: 'http://127.0.0.1:9324/1/q' })).toEqual([]);
        expect(sqs.validate({ ...env, DC_INSECURE_PRIVATE_SERVICES: 'on', DC_SQS_QUEUE_URL: 'http://queue.example.test/1/q' })).toEqual([]);
    });
});
