// The Async Workloads function: Netlify runs each `starter-crm-webhook-job` event here, after the webhook queued it.
//
// Where it sits: `DC_WEBHOOKS=netlify-async` (the default on Netlify) sends the event from the webhook; Async Workloads
// calls this function with it and retries it when it throws (lib/webhook-job.js decides which). The SDK's wrapper
// checks the AWL_API_KEY the router sends, so nothing else can run an event. The processor counts the attempts, so
// `maxRetries` is set above DC_WEBHOOK_MAX_ATTEMPTS' maximum and the processor's own limit is the one that applies.
// The event name is written out because Netlify reads this config without running the file; a test checks it matches
// the provider's EVENT. What a customer changes: nothing.
import { asyncWorkloadFn } from '@netlify/async-workloads';
import { core, coreModule } from '../lib/core.js';
import { runJob } from '../lib/webhook-job.js';

export default asyncWorkloadFn(async (event) => {
    const { backoffMs } = await coreModule('processor.js');
    return runJob(event, await core(), backoffMs);
});

export const asyncWorkloadConfig = {
    events: ['starter-crm-webhook-job'],
    maxRetries: 50
};
