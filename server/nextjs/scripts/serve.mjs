// Runs the built Next.js variant on your own machine or server: `npm start`.
//
// Where it sits: `next start` would do, but a route handler cannot see the TCP peer or the path exactly as the client
// sent it (Next resolves `..` before routing), and neither can it drain on SIGTERM. This launcher puts a plain
// Node HTTP server in front of Next's request handler and does those three things:
// - it stamps the peer address and the raw path on each request, replacing anything the client sent, and sets
//   STARTER_CRM_LAUNCHER so lib/core.js reads them (on Vercel the platform provides the client address and nothing
//   here runs);
// - on SIGTERM or SIGINT it drains like the Node server: readiness turns 503, event streams end, the listener closes
//   and the process exits within DC_SHUTDOWN_GRACE_SECONDS;
// - it boots the core before it listens, so a configuration problem exits with the list of problems, runs the worker and
//   maintenance loop like the Node server does, and reads HOST and PORT (defaults 127.0.0.1 and 3000).
// Run `npm run build` first. What a customer changes: nothing.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..');
const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

process.env.STARTER_CRM_LAUNCHER = 'on';

const { core } = await import('../lib/core.js');
const booted = await core();
if (!booted.ok) process.exit(1);

/** A path Next would resolve to a different one before routing (dot segments, backslashes, encoded slashes). */
const UNUSUAL_PATH = /(^|\/)\.{1,2}(\/|$)|\\|%2e|%2f|%5c|\/\//i;

const app = next({ dev: false, dir, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();

const server = http.createServer((req, res) => {
    req.headers['x-starter-crm-peer'] = req.socket.remoteAddress || '';
    const [rawPath, ...query] = (req.url || '/').split('?');
    req.headers['x-starter-crm-raw-path'] = rawPath;
    // Next would answer such a path with a redirect to its resolved form; the core judges the path as sent instead.
    if (UNUSUAL_PATH.test(rawPath)) req.url = '/_raw' + (query.length ? '?' + query.join('?') : '');
    handle(req, res).catch((err) => {
        console.error('A request failed: ' + err.message);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
    });
});

try {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, hostname, resolve);
    });
} catch (err) {
    console.error('Could not listen on ' + hostname + ':' + port + ': ' + err.message);
    process.exit(1);
}
const { config, log } = booted;
await log.info('Starter CRM server (DC_AUTH_MODE=' + config.mode + ', DC_ENV=' + config.env + ', DC_IDENTITY=' + config.identity
    + ') on http://' + hostname + ':' + port + ' (Next.js)');
await log.info('Events: DC_STORE=' + config.events.store + ', DC_FANOUT=' + config.events.fanout + ', DC_WEBHOOKS=' + config.events.webhooks);
if (config.webhookSecrets.length === 0) {
    await log.warn('DROPCOWBOY_WEBHOOK_SECRET is not set, so webhooks will be refused with 503.');
}
if (config.publicUrl) {
    await log.info('Point Drop Cowboy webhooks at ' + config.publicUrl + '/webhooks/dropcowboy');
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => drain());
}

/**
 * Drains and exits: ends the event streams, closes the listener, then stops the runtime.
 *
 * @returns {Promise<void>} Never rejects; any failure still ends in an exit.
 */
async function drain() {
    if (shuttingDown) return;
    shuttingDown = true;
    const { lifecycle } = booted.core;
    const forceTimer = setTimeout(() => {
        server.closeAllConnections();
        process.exit(0);
    }, lifecycle.graceSeconds * 1000);
    forceTimer.unref();
    try {
        await lifecycle.beginDrain();
        await new Promise((resolve) => server.close(resolve));
        await booted.core.runtime.stop();
    } catch (err) {
        console.error('Shutdown did not finish cleanly: ' + err.message);
    }
    clearTimeout(forceTimer);
    process.exit(0);
}
