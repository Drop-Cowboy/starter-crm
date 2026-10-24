/**
 * Process entry for the Node Starter CRM server.
 *
 * Where it sits: `npm start` in server/node (and the root `npm start`) runs
 * this file. It loads `.env`, validates config, listens, and drains on SIGTERM.
 *
 * CONTRACT.md: Boot, Shutdown.
 * Customers normally only change `.env`; replace requireUser() for real auth.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { starterRoot } from './config.js';
import { isLoopbackAddress } from './dev-session.js';
import { formatProblems } from './problems.js';

// Variables already in the environment win over .env.
const root = starterRoot(process.env);
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const booted = await bootstrap(process.env, root);
if (booted.problems.length > 0) {
    console.error('The Starter CRM server cannot start:\n' + formatProblems(booted.problems) +
        '\nEach problem above names the setting to change: in .env at the starter root when you run it yourself ' +
        '(npm run setup writes one), or in your host\'s settings. More help: TROUBLESHOOTING.md.');
    process.exit(1);
}

const { config, log } = booted;
const app = createApp(config, {
    log,
    identity: booted.identity || undefined,
    ratelimit: booted.ratelimit,
    observer: booted.observer || undefined,
    secrets: booted.secrets || undefined,
    runtime: booted.runtime
});
const runtime = booted.runtime;
const lifecycle = app.get('lifecycle');

// Listening is awaited so every log call below is awaited too. Express 5
// calls the callback with the error when listening fails; the 'error'
// listener rejects the same promise, so a failure to bind is reported once.
let server;
try {
    await new Promise((resolve, reject) => {
        server = app.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
        server.once('error', reject);
    });
} catch (err) {
    await log.error('Could not listen on ' + config.host + ':' + config.port + ': ' + err.message);
    process.exit(1);
}

try {
    await runtime.start();
} catch (err) {
    await log.error('Could not start the event runtime: ' + err.message);
    process.exit(1);
}

const address = server.address();
const host = address.family === 'IPv6' ? '[' + address.address + ']' : address.address;
await log.info('Starter CRM server (DC_AUTH_MODE=' + config.mode + ', DC_ENV=' + config.env
    + ', DC_IDENTITY=' + config.identity + ') on http://' + host + ':' + address.port);
await log.info('Events: DC_STORE=' + config.events.store + ', DC_FANOUT=' + config.events.fanout + ', DC_WEBHOOKS=' + config.events.webhooks
    + (config.events.workerInProcess ? '' : ' (worker runs separately: npm run worker)'));
if (!isLoopbackAddress(address.address) && address.address !== 'localhost') {
    await log.warn('HOST is not loopback: other machines on your network can reach this server.');
}
if (config.webhookSecrets.length === 0) {
    await log.warn('DROPCOWBOY_WEBHOOK_SECRET is not set, so webhooks will be refused with 503.');
}
// Point operators at the public webhook URL when they set DC_PUBLIC_URL.
if (config.publicUrl) {
    await log.info('Point Drop Cowboy webhooks at ' + config.publicUrl + '/webhooks/dropcowboy');
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // Stop accepting new connections, close SSE streams (so server.close
        // can finish), then exit within DC_SHUTDOWN_GRACE_SECONDS.
        // Do not call closeAllConnections() first: that drops in-flight work.
        const graceMs = lifecycle.graceSeconds * 1000;
        const forceTimer = setTimeout(() => {
            try {
                server.closeAllConnections();
            } catch {
                // Older Node without closeAllConnections.
            }
            process.exit(0);
        }, graceMs);
        forceTimer.unref?.();
        await shutdown(forceTimer);
    });
}

/**
 * Drains: ends the event streams, closes the listener, lets the worker finish the event in hand, then exits.
 *
 * @param {NodeJS.Timeout} forceTimer The grace-period timer, cleared when the drain finishes in time.
 * @returns {Promise<void>} Never rejects; any failure still ends in an exit.
 */
async function shutdown(forceTimer) {
    try {
        await lifecycle.beginDrain();
        await new Promise((resolve) => server.close(resolve));
        await runtime.stop();
    } catch (err) {
        await log.error('Shutdown did not finish cleanly: ' + err.message);
    }
    clearTimeout(forceTimer);
    process.exit(0);
}
