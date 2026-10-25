#!/usr/bin/env node
/**
 * `npm run soak`: holds many open event streams while signed webhooks arrive at a steady rate, and checks
 * that every webhook is acknowledged quickly, every stream gets every event, and memory stays flat.
 *
 * Where it sits: starter root. It starts one server itself (Node, or Python under Gunicorn) with throwaway
 * credentials on a free local port, so it never touches an account or a real webhook. The weekly workflow
 * runs it for 10 minutes with each profile; run it by hand with `--duration 30` to try a change.
 *
 *   node scripts/soak.mjs --profile sqlite --server node
 *   node scripts/soak.mjs --profile postgres-redis --server python --duration 60 --streams 200
 *
 *   --profile   sqlite (outbox worker, one instance) or postgres-redis (Postgres store, Redis fan-out, BullMQ)
 *   --server    node or python
 *   --duration  seconds of load after the warm-up (default 600)
 *   --streams   open /api/events streams (default 500)
 *   --rate      webhooks per second (default 50)
 *   --warmup    seconds before memory is compared (default 30)
 *   --workers   Gunicorn workers for the Python server (default 1). More than one needs the postgres-redis
 *               profile, because the sqlite profile's fan-out only reaches streams in its own process.
 *
 * The postgres-redis profile reads STARTER_TEST_DATABASE_URL and STARTER_TEST_REDIS_URL, which default to the
 * services in tests/services.compose.yml.
 *
 * It uses node:http rather than autocannon: the load is one signed POST at a fixed rate, and keeping it here
 * adds no dependency to the starter.
 *
 * Plan section 12, item 10. Exit 0 when every check passes, 1 otherwise.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSseParser, memoryGrowth, percentile, verdict } from './lib/soak-stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBHOOK_SECRET = 'soak-test-webhook-secret-not-real';
const DEFAULT_DATABASE_URL = 'postgres://starter:starter-crm-dev@127.0.0.1:55432/starter_crm';
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:56379';

const options = readOptions(process.argv.slice(2));
const warmupMs = options.warmup * 1000;
const durationMs = options.duration * 1000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-soak-'));
fs.writeFileSync(path.join(tmp, 'handlers.js'), "export const handlers = { '*': async () => {} };\n");
fs.writeFileSync(path.join(tmp, 'handlers.py'), 'def handle(event, ctx):\n    return None\n\n\nhandlers = {"*": handle}\n');

const server = await startServer();
const siteUrl = server.url;
console.log('Server up at ' + siteUrl + ' (' + options.server + ', profile ' + options.profile + ')');

const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
const streams = [];
const posted = [];
const ackMs = [];
let failed = 0;
let delivered = 0;
let streamsLost = 0;
let sampledOne = false;
const sentAt = new Map();
const lagMs = [];

let exitCode = 1;
try {
    await openStreams();
    console.log(streams.length + ' streams open. Warming up for ' + options.warmup + ' s, then ' + options.duration + ' s of load at ' + options.rate + ' webhooks/s.');
    const samples = [];
    const started = Date.now();
    const sampler = setInterval(() => samples.push({ at: Date.now() - started, rssMb: server.rssMb() }), 2000);
    const sender = startSender();

    await sleep(warmupMs + durationMs);
    clearInterval(sender);
    // Let the last events reach the streams before counting.
    const settleBy = Date.now() + 60000;
    while (Date.now() < settleBy && delivered < posted.length * streams.length) await sleep(250);
    clearInterval(sampler);

    for (const stream of streams) if (stream.closedEarly) streamsLost++;
    const expectedDeliveries = posted.length * streams.length;
    const memory = memoryGrowth(samples, warmupMs);
    const result = verdict({ ackMs, posted: posted.length, failed, expectedDeliveries, delivered, streamsLost, memory });
    console.log(JSON.stringify({
        server: options.server,
        profile: options.profile,
        workers: options.workers,
        streams: streams.length,
        webhooks: posted.length,
        failed,
        ack_ms: { p50: Math.round(result.ackP50Ms), p99: Math.round(result.ackP99Ms) },
        delivery_lag_ms: { p50: Math.round(percentile(lagMs, 50)), p99: Math.round(percentile(lagMs, 99)), max: Math.round(Math.max(0, ...lagMs)) },
        delivered_ratio: Number(result.deliveredRatio.toFixed(5)),
        streams_lost: streamsLost,
        memory_mb: memory.enough ? { start: Math.round(memory.startMb), end: Math.round(memory.endMb) } : 'too few samples',
        ok: result.ok
    }, null, 2));
    for (const problem of result.problems) console.error('FAIL ' + problem);
    exitCode = result.ok ? 0 : 1;
} catch (err) {
    console.error('The soak run failed: ' + (err && err.message ? err.message : err));
    console.error(server.output().slice(-2000));
} finally {
    for (const stream of streams) stream.destroy();
    agent.destroy();
    await server.stop().catch((err) => {
        console.error(err.message);
        exitCode = 1;
    });
    fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);

/**
 * Reads the command line.
 *
 * @param {string[]} argv The arguments after the script name.
 * @returns {{ profile: string, server: string, duration: number, streams: number, rate: number, warmup: number, workers: number }} The options.
 */
function readOptions(argv) {
    const out = { profile: 'sqlite', server: 'node', duration: 600, streams: 500, rate: 50, warmup: 30, workers: 1 };
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in out) || argv[i + 1] === undefined) {
            console.error('Usage: node scripts/soak.mjs [--profile sqlite|postgres-redis] [--server node|python] [--duration s] [--streams n] [--rate n] [--warmup s] [--workers n]');
            process.exit(2);
        }
        out[key] = typeof out[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
    }
    if (!['sqlite', 'postgres-redis'].includes(out.profile) || !['node', 'python'].includes(out.server)
        || [out.duration, out.streams, out.rate, out.warmup].some((n) => !Number.isFinite(n) || n < 0)
        || !Number.isInteger(out.workers) || out.workers < 1) {
        console.error('Unknown profile or server, or a number that is not valid.');
        process.exit(2);
    }
    if (out.workers > 1 && (out.server !== 'python' || out.profile !== 'postgres-redis')) {
        console.error('--workers above 1 needs --server python and --profile postgres-redis.');
        process.exit(2);
    }
    return out;
}

/**
 * Starts the server under test and waits for it to answer.
 *
 * @returns {Promise<{ url: string, rssMb: () => number, output: () => string, stop: () => Promise<void> }>} The server.
 */
async function startServer() {
    const port = await freePort();
    const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONUNBUFFERED: '1',
        DC_AUTH_MODE: 'server',
        DC_IDENTITY: 'dev',
        DROPCOWBOY_API_KEY: 'soak-key',
        DROPCOWBOY_API_SECRET: 'soak-secret',
        DROPCOWBOY_SITE_ID: crypto.randomUUID(),
        DROPCOWBOY_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STARTER_CRM_USER_ID: crypto.randomUUID(),
        STARTER_CRM_ROOT: tmp,
        HOST: '127.0.0.1',
        PORT: String(port),
        DC_WEBHOOK_HANDLERS: options.server === 'python' ? './handlers.py' : './handlers.js',
        DC_RATE_LIMIT: 'off'
    };
    if (options.profile === 'sqlite') {
        Object.assign(env, { DC_STORE: 'sqlite', DC_SQLITE_PATH: path.join(tmp, 'soak.sqlite'), DC_WEBHOOKS: 'store', DC_FANOUT: 'local' });
    } else {
        Object.assign(env, {
            DC_STORE: 'postgres',
            DC_DATABASE_URL: process.env.STARTER_TEST_DATABASE_URL || DEFAULT_DATABASE_URL,
            DC_REDIS_URL: process.env.STARTER_TEST_REDIS_URL || DEFAULT_REDIS_URL,
            DC_FANOUT: 'redis',
            DC_WEBHOOKS: 'bullmq'
        });
    }
    let command;
    let args;
    let cwd;
    if (options.server === 'node') {
        [command, args, cwd] = [process.execPath, ['src/index.js'], path.join(ROOT, 'server', 'node')];
    } else {
        cwd = path.join(ROOT, 'server', 'python');
        const venv = path.join(cwd, '.venv', 'bin', 'python');
        // One thread holds each open stream. Workers share one listening socket and nothing spreads the
        // streams evenly between them, so every worker's pool must be able to hold all of them.
        env.GUNICORN_THREADS = String(options.streams + 50);
        env.WEB_CONCURRENCY = String(options.workers);
        [command, args] = [fs.existsSync(venv) ? venv : 'python3', ['-m', 'gunicorn', '-c', 'gunicorn.conf.py', 'starter_crm.wsgi:app']];
    }
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const url = 'http://127.0.0.1:' + port;
    const deadline = Date.now() + 60000;
    for (;;) {
        if (child.exitCode !== null) throw new Error('The server exited before it answered.\n' + output);
        if (await fetch(url + '/healthz').then((res) => res.ok, () => false)) break;
        if (Date.now() > deadline) throw new Error('The server did not answer /healthz within 60 s.\n' + output);
        await sleep(200);
    }
    return {
        url,
        output: () => output,
        rssMb: () => treeRssMb(child.pid),
        async stop() {
            if (child.exitCode !== null) return;
            process.kill(-child.pid, 'SIGTERM');
            const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 15000);
            await exited;
            clearTimeout(timer);
        }
    };
}

/**
 * The resident memory of a process and its children, which is what Gunicorn's workers are.
 *
 * @param {number} pid The server's process id.
 * @returns {number} Megabytes (0 when it cannot be read).
 */
function treeRssMb(pid) {
    const listing = spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    if (listing.status !== 0) return 0;
    const rows = listing.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const inTree = new Set([pid]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [child, parent] of rows) {
            if (inTree.has(parent) && !inTree.has(child)) {
                inTree.add(child);
                grew = true;
            }
        }
    }
    return rows.filter(([id]) => inTree.has(id)).reduce((sum, row) => sum + row[2], 0) / 1024;
}

/** Opens `options.streams` event streams, a few at a time so the server's accept queue is not flooded. */
async function openStreams() {
    for (let i = 0; i < options.streams; i += 25) {
        const batch = [];
        for (let j = i; j < Math.min(options.streams, i + 25); j++) batch.push(openStream());
        streams.push(...await Promise.all(batch));
    }
}

/**
 * Opens one `/api/events` stream and counts the messages that are for events this run posted.
 *
 * @returns {Promise<http.ClientRequest & { closedEarly?: boolean }>} The request, once the replay has finished.
 */
function openStream() {
    return new Promise((resolve, reject) => {
        const parser = createSseParser();
        let ended = false;
        const sampled = streams.length === 0 && !sampledOne;
        sampledOne = sampledOne || sampled;
        const req = http.get(siteUrl + '/api/events', { agent, headers: { accept: 'text/event-stream' } }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error('GET /api/events answered ' + res.statusCode));
                return;
            }
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                for (const message of parser.push(chunk)) {
                    if (message.event === 'replayed') resolve(req);
                    else if (message.event === 'message' && message.id && sentAt.has(message.id)) {
                        delivered++;
                        if (sampled) lagMs.push(Date.now() - sentAt.get(message.id));
                    }
                }
            });
            res.on('close', () => {
                if (!ended) req.closedEarly = true;
            });
        });
        req.on('error', (err) => {
            if (ended) return;
            req.closedEarly = true;
            reject(err);
        });
        const destroy = req.destroy.bind(req);
        req.destroy = (...rest) => {
            ended = true;
            return destroy(...rest);
        };
    });
}

/**
 * Posts signed webhooks at `options.rate` per second until the returned timer is cleared.
 *
 * @returns {NodeJS.Timeout} The timer.
 */
function startSender() {
    const startedAt = Date.now();
    let sent = 0;
    // Send what is due on each tick, so a slow tick catches up instead of lowering the rate.
    return setInterval(() => {
        const due = Math.floor(((Date.now() - startedAt) / 1000) * options.rate);
        while (sent < due) {
            sent++;
            postWebhook();
        }
    }, 20);
}

/** Sends one signed webhook and records how long the acknowledgement took. */
function postWebhook() {
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
        event_id: eventId,
        event: 'contact.msg.received',
        event_at: Date.now(),
        data: { contact_id: crypto.randomUUID() }
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(timestamp + '.' + body).digest('hex');
    sentAt.set(eventId, Date.now());
    posted.push(eventId);
    const started = performance.now();
    const req = http.request(siteUrl + '/webhooks/dropcowboy', {
        method: 'POST',
        agent,
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-signature': signature,
            'x-timestamp': timestamp,
            'x-signature-version': 'v1',
            'x-event-id': eventId
        }
    }, (res) => {
        res.resume();
        res.on('end', () => {
            if (res.statusCode === 200) ackMs.push(performance.now() - started);
            else failed++;
        });
    });
    req.on('error', () => { failed++; });
    req.end(body);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
