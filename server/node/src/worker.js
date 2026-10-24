/**
 * Process entry for a separate webhook worker: `npm run worker`.
 *
 * Where it sits: with `DC_WORKER_IN_PROCESS=off` on the web instances, this process
 * takes the handler work (the outbox for `DC_WEBHOOKS=store`, the queue for `bullmq`).
 * It boots the same config and providers as the server, so it needs the same `.env`,
 * and a store and fan-out that other processes can reach: a `sqlite` file on the same
 * machine, or `postgres` or `redis`, with `DC_FANOUT` set to `poll`, `redis` or `postgres`.
 * It serves no HTTP. On SIGTERM it finishes the event in hand and exits.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing), Shutdown.
 * What a customer changes: nothing.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { bootstrap } from './bootstrap.js';
import { starterRoot } from './config.js';
import { formatProblems } from './problems.js';

const root = starterRoot(process.env);
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const booted = await bootstrap(process.env, root);
if (booted.problems.length > 0) {
    console.error('The Starter CRM worker cannot start:\n' + formatProblems(booted.problems));
    process.exit(1);
}

const { config, log, runtime } = booted;
if (config.events.store === 'memory') {
    await log.error('A separate worker needs a store the web process can also read. Set DC_STORE to sqlite, postgres or redis.');
    process.exit(1);
}
if (config.events.fanout === 'local') {
    await log.error('A separate worker needs a fan-out that reaches the web process. Set DC_FANOUT to poll, redis or postgres.');
    process.exit(1);
}

// This process exists to run the worker, whatever DC_WORKER_IN_PROCESS says for the web instances.
config.events.workerInProcess = true;
await runtime.start();
await log.info('Starter CRM worker running (DC_STORE=' + config.events.store + ', DC_WEBHOOKS=' + config.events.webhooks + ').');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        const forceTimer = setTimeout(() => process.exit(0), config.shutdownGraceSeconds * 1000);
        forceTimer.unref?.();
        try {
            await runtime.stop();
        } catch (err) {
            await log.error('Worker shutdown did not finish cleanly: ' + err.message);
        }
        clearTimeout(forceTimer);
        process.exit(0);
    });
}
