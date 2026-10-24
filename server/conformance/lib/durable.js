// Helpers for the durable-events suite: servers with their own handlers file,
// a second server in the other language, and an SSE reader that stays open.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctx, signature } from './context.js';
import { makeRoot, serverEnv } from './oneoff.js';
import { baseEnv, freePort, spawnServer, stopServer, waitForHealth } from './process.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const POSTGRES_URL = process.env.STARTER_TEST_DATABASE_URL || 'postgres://starter:starter-crm-dev@127.0.0.1:55432/starter_crm';
export const REDIS_URL = process.env.STARTER_TEST_REDIS_URL || 'redis://127.0.0.1:56379';
export const REDIS_CLUSTER_URL = process.env.STARTER_TEST_REDIS_CLUSTER_URL || 'redis://127.0.0.1:55380';

/**
 * Tries a TCP connection.
 *
 * @param {string} url A service URL.
 * @returns {Promise<boolean>} True when something accepts connections there.
 */
function reachable(url) {
    const { hostname, port } = new URL(url);
    return new Promise((resolve) => {
        const socket = net.connect({ host: hostname, port: Number(port) });
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => resolve(false));
    });
}

export const HAVE_POSTGRES = await reachable(POSTGRES_URL);
export const HAVE_REDIS = await reachable(REDIS_URL);
export const HAVE_REDIS_CLUSTER = await reachable(REDIS_CLUSTER_URL);

export const DYNAMODB_URL = process.env.STARTER_TEST_DYNAMODB_URL || 'http://127.0.0.1:58000';
export const SQS_URL = process.env.STARTER_TEST_SQS_URL || 'http://127.0.0.1:59324';
export const HAVE_DYNAMODB = await reachable(DYNAMODB_URL);
export const HAVE_SQS = await reachable(SQS_URL);

export const QSTASH_URL = process.env.STARTER_TEST_QSTASH_URL || 'http://127.0.0.1:58080';
export const HAVE_QSTASH = await reachable(QSTASH_URL);

/**
 * The settings for the `qstash` mode against the QStash development server, which prints the same credentials on every
 * machine. It calls the server back through `host.docker.internal`, so the server listens on every interface and
 * `{port}` in a value becomes the port `start()` picked.
 *
 * @returns {Record<string, string>} Environment variables for a server.
 */
export function qstashEnv() {
    return {
        HOST: '0.0.0.0',
        DC_PUBLIC_URL: 'http://host.docker.internal:{port}',
        QSTASH_URL,
        QSTASH_TOKEN: 'eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=',
        QSTASH_CURRENT_SIGNING_KEY: 'sig_' + '7kYjw48mhY7kAjqNGcy6cr29RJ6r',
        QSTASH_NEXT_SIGNING_KEY: 'sig_' + '5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs'
    };
}

/**
 * The settings that point a server's AWS SDK at dynamodb-local and ElasticMQ. The credentials are dummies: the
 * stand-ins accept any.
 *
 * @returns {Record<string, string>} Environment variables for a server.
 */
export function awsEnv() {
    return {
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        AWS_ENDPOINT_URL_DYNAMODB: DYNAMODB_URL,
        AWS_ENDPOINT_URL_SQS: SQS_URL,
        DC_DYNAMODB_AUTO_CREATE: 'on'
    };
}

/**
 * Creates a fresh queue on ElasticMQ, so every case has a queue of its own (a queue shared by two sites would
 * hand one site's messages to the other's worker).
 *
 * @param {Record<string, string>} [attributes] Queue attributes, such as `VisibilityTimeout`.
 * @returns {Promise<string>} The queue URL a client on this machine reaches it by.
 */
export async function createQueue(attributes = {}) {
    const name = 'webhooks-' + crypto.randomUUID();
    const form = new URLSearchParams({ Action: 'CreateQueue', QueueName: name, 'Attribute.1.Name': 'VisibilityTimeout', 'Attribute.1.Value': attributes.VisibilityTimeout || '30' });
    const res = await fetch(SQS_URL + '/', { method: 'POST', body: form });
    if (!res.ok) throw new Error('ElasticMQ would not create a queue: HTTP ' + res.status);
    // ElasticMQ answers with its in-container address, so the URL is built from the one this machine uses.
    return SQS_URL + '/000000000000/' + name;
}

/**
 * The handlers file every server in this suite runs. Each call is one line in `calls.log`
 * (the event id), `contact.slow` takes 2.5 seconds, and any event fails while `fail.flag` exists.
 *
 * @param {'node'|'python'} lang The server language.
 * @returns {string} The file's source.
 */
export function handlersSource(lang) {
    if (lang === 'python') {
        return `import os
import time

ROOT = os.path.dirname(os.path.abspath(__file__))


def handle(event, ctx):
    with open(os.path.join(ROOT, "calls.log"), "a", encoding="utf-8") as log:
        log.write(ctx.event_id + "\\n")
    if event["event"] == "contact.slow":
        time.sleep(2.5)
    if os.path.exists(os.path.join(ROOT, "fail.flag")):
        raise RuntimeError("forced failure")


handlers = {"*": handle}
`;
    }
    return `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export const handlers = {
    '*': async (event, { eventId }) => {
        fs.appendFileSync(path.join(root, 'calls.log'), eventId + '\\n');
        if (event.event === 'contact.slow') await new Promise((resolve) => setTimeout(resolve, 2500));
        if (fs.existsSync(path.join(root, 'fail.flag'))) throw new Error('forced failure');
    }
};
`;
}

/**
 * How to start the server written in `lang`, or null when it cannot be started here.
 *
 * @param {'node'|'python'} lang The language.
 * @returns {{ command: string, cwd: string } | null} The command and folder.
 */
export function commandFor(lang) {
    if (lang === ctx.serverLang) return { command: ctx.serverCmd, cwd: ctx.serverCwd };
    if (lang === 'node') return { command: 'node src/index.js', cwd: path.resolve(here, '..', '..', 'node') };
    const cwd = path.resolve(here, '..', '..', 'python');
    const venv = path.join(cwd, '.venv', 'bin', 'python');
    return fs.existsSync(path.join(cwd, 'starter_crm')) ? { command: (fs.existsSync(venv) ? venv : 'python3') + ' -m starter_crm', cwd } : null;
}

/**
 * Starts one server of `lang` in a fresh root with the suite's handlers file.
 *
 * @param {{ lang?: 'node'|'python', env?: Record<string, string>, root?: string }} options Language, settings and a root to reuse.
 * @returns {Promise<{ url: string, root: string, calls: () => string[], flag: (on: boolean) => void, stop: () => Promise<void>, output: () => string }>} The server.
 */
export async function start({ lang = ctx.serverLang, env = {}, root } = {}) {
    const found = commandFor(lang);
    const ext = lang === 'python' ? 'py' : 'js';
    const dir = root || makeRoot({ ['handlers.' + ext]: handlersSource(lang) });
    const port = await freePort();
    const withPort = {};
    for (const [key, value] of Object.entries(env)) withPort[key] = String(value).replaceAll('{port}', String(port));
    const proc = spawnServer({
        command: found.command,
        cwd: found.cwd,
        env: {
            ...baseEnv(),
            ...serverEnv(),
            STARTER_CRM_ROOT: dir,
            HOST: '127.0.0.1',
            PORT: String(port),
            DC_WEBHOOK_HANDLERS: './handlers.' + ext,
            DC_OUTBOX_POLL_MS: '100',
            DC_FANOUT_POLL_MS: '100',
            ...withPort
        }
    });
    const url = 'http://127.0.0.1:' + port;
    await waitForHealth(url, proc);
    const log = path.join(dir, 'calls.log');
    return {
        url,
        root: dir,
        output: proc.output,
        calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
        flag: (on) => {
            const file = path.join(dir, 'fail.flag');
            if (on) fs.writeFileSync(file, '1');
            else fs.rmSync(file, { force: true });
        },
        stop: () => stopServer(proc)
    };
}

/**
 * Deletes a server's root once it has stopped.
 *
 * @param {{ root: string }} server A server from `start()`.
 */
export function cleanup(server) {
    fs.rmSync(server.root, { recursive: true, force: true });
}

/**
 * Delivers a signed webhook to `url`.
 *
 * @param {string} url The server's base URL.
 * @param {string} eventId The event id.
 * @param {string} [event] The event name.
 * @returns {Promise<{ status: number, body: any, elapsed: number }>} The answer and how long it took.
 */
export async function post(url, eventId, event = 'contact.msg.received') {
    const body = JSON.stringify({ event_id: eventId, event, event_at: Date.now(), data: { contact_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const started = Date.now();
    const res = await fetch(url + '/webhooks/dropcowboy', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-signature': signature(body, ctx.secrets.webhookSecret, timestamp),
            'x-timestamp': timestamp,
            'x-signature-version': 'v1',
            'x-attempt': '1'
        },
        body
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, elapsed: Date.now() - started };
}

/**
 * Opens `/api/events` and keeps it open, collecting messages.
 *
 * @param {string} url The server's base URL.
 * @param {Record<string, string>} [headers] Extra request headers (`Last-Event-ID`).
 * @returns {Promise<{ messages: object[], waitFor: (test: (messages: object[]) => boolean, ms?: number) => Promise<boolean>, close: () => void }>} The open stream.
 */
export async function openStream(url, headers = {}) {
    const controller = new AbortController();
    const res = await fetch(url + '/api/events', { headers, signal: controller.signal });
    if (res.status !== 200) throw new Error('GET /api/events answered ' + res.status);
    const messages = [];
    (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        const reader = res.body.getReader();
        for (;;) {
            const chunk = await reader.read().catch(() => ({ done: true }));
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end;
            while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
                let id = null;
                let name = 'message';
                const data = [];
                for (const line of block.split(/\r?\n/)) {
                    if (line.startsWith('id:')) id = line.slice(3).trim();
                    else if (line.startsWith('event:')) name = line.slice(6).trim();
                    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
                }
                if (data.length) messages.push({ id, event: name, data: JSON.parse(data.join('\n')) });
            }
        }
    })();
    return {
        messages,
        waitFor: async (test, ms = 8000) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                if (test(messages)) return true;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return test(messages);
        },
        close: () => controller.abort()
    };
}

/**
 * Waits until `check()` is truthy.
 *
 * @param {() => any} check What to test.
 * @param {number} [ms] How long to wait.
 * @returns {Promise<boolean>} Whether it became truthy in time.
 */
export async function until(check, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return Boolean(check());
}
