// Runs the Netlify variant's function on your own machine: `npm start`.
//
// Where it sits: a plain Node HTTP server in front of functions/api.mjs, the function Netlify runs for every path its
// CDN has no file for. Here every path goes to the function, and the core serves the front-ends itself, exactly as it
// does in the Node server, so the conformance suite and the browser tests run against the function's own code without
// Netlify. What only Netlify does (the CDN, `_headers`, Async Workloads, the schedule) is checked against a deploy, with
// `npm run test:deployed`.
//
// - It stamps the peer address and the raw path on each request, replacing anything the client sent, and sets
//   STARTER_CRM_LAUNCHER so lib/core.js reads them.
// - It boots the core before it listens, so a configuration problem exits with the list of problems, and runs the
//   worker and maintenance loop like the Node server does. HOST and PORT default to 127.0.0.1 and 3000.
// - On SIGTERM or SIGINT it drains like the Node server: readiness turns 503, event streams end, the listener closes
//   and the process exits within DC_SHUTDOWN_GRACE_SECONDS.
// What a customer changes: nothing.
import http from 'node:http';
import { Readable } from 'node:stream';

const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

process.env.STARTER_CRM_LAUNCHER = 'on';

const { core } = await import('../lib/core.js');
const { default: api } = await import('../functions/api.mjs');
const booted = await core();
if (!booted.ok) process.exit(1);

/**
 * The incoming request as the Request a Netlify function receives.
 *
 * @param {http.IncomingMessage} req The Node request.
 * @param {AbortSignal} signal Aborted when the client goes away.
 * @returns {Request} The same method, URL, headers and body.
 */
function toRequest(req, signal) {
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const [rawPath] = (req.url || '/').split('?');
    headers.set('x-starter-crm-peer', req.socket.remoteAddress || '');
    headers.set('x-starter-crm-raw-path', rawPath);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    return new Request('http://' + (req.headers.host || hostname + ':' + port) + (req.url || '/'), {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
        signal
    });
}

/**
 * Writes the function's Response to the Node response, streaming the body.
 *
 * @param {Response} response The function's answer.
 * @param {http.ServerResponse} res The Node response.
 * @returns {Promise<void>} Resolves when the body has been written or the client has gone.
 */
async function send(response, res) {
    const headers = {};
    for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') headers[name] = value;
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (!response.body) {
        res.end();
        return;
    }
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve));
        }
    } finally {
        res.end();
    }
}

const server = http.createServer((req, res) => {
    const aborted = new AbortController();
    res.on('close', () => aborted.abort());
    (async () => {
        const response = await api(toRequest(req, aborted.signal), { ip: req.socket.remoteAddress });
        await send(response, res);
    })().catch((err) => {
        if (aborted.signal.aborted) return;
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
    + ') on http://' + hostname + ':' + port + ' (Netlify function)');
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
