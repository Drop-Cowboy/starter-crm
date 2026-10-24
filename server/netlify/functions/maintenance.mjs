// The scheduled maintenance run: re-queue events whose message was lost, and prune past retention.
//
// Where it sits: a Netlify scheduled function. Netlify runs it on the schedule below and refuses calls from anywhere
// else, so it needs no secret. A serverless app has no loop between requests, so this is what the Node server's
// maintenance loop becomes. What a customer changes: nothing, or the schedule.
import { core } from '../lib/core.js';

export default async () => {
    const result = await core();
    if (!result.ok) return new Response(null, { status: 503 });
    await result.core.runtime.maintainOnce();
    return new Response(null, { status: 204 });
};

export const config = {
    schedule: '17 4 * * *'
};
