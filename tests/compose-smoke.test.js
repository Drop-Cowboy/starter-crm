// Proves compose.yaml works as documented: `docker compose up` builds the image,
// mounts the secret files, reads them with DC_SECRETS=file, and serves.
//
//   node --test tests/compose-smoke.test.js
//
// Where it sits: `npm test` runs it as the container:compose stage
// (tests/run-all.mjs). It needs Docker with the compose plugin, and no settings
// or secrets of yours: the secrets are made-up files in a temporary folder that
// SECRETS_DIR points at, so a ./secrets folder of your own is never touched. The
// project name is fixed, so a run never collides with your own `docker compose up`.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'starter-crm-compose-check';

let secretsDir;
let siteId;
let port;
const secretValues = {};

/** Runs `docker compose` for this project with the test's own settings. */
function compose(args, extraEnv = {}) {
    return spawnSync('docker', ['compose', '-p', PROJECT, '-f', path.join(ROOT, 'compose.yaml'), ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DOCKER_HOST: process.env.DOCKER_HOST || '',
            SECRETS_DIR: secretsDir,
            DROPCOWBOY_SITE_ID: siteId,
            PORT: String(port),
            ...extraEnv
        },
        timeout: 600_000
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port: found } = server.address();
            server.close(() => resolve(found));
        });
    });
}

before(async () => {
    secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-compose-'));
    fs.chmodSync(secretsDir, 0o755);
    siteId = crypto.randomUUID();
    port = await freePort();
    for (const name of ['DROPCOWBOY_API_KEY', 'DROPCOWBOY_API_SECRET', 'DROPCOWBOY_WEBHOOK_SECRET', 'DC_PASSCODE']) {
        secretValues[name] = 'compose-check-' + crypto.randomUUID();
        // Readable by any user: the container runs as uid 1000, and a CI runner's own uid is often 1001.
        fs.writeFileSync(path.join(secretsDir, name), secretValues[name], { mode: 0o644 });
    }
});

after(() => {
    compose(['--profile', 'python', '--profile', 'redis', '--profile', 'python-redis', 'down', '--volumes', '--remove-orphans', '--rmi', 'local', '--timeout', '3']);
    fs.rmSync(secretsDir, { recursive: true, force: true });
});

describe('compose.yaml', () => {
    it('refuses to start without a site id, and says what to do', () => {
        const result = compose(['config'], { DROPCOWBOY_SITE_ID: '' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /DROPCOWBOY_SITE_ID/);
        assert.match(result.stderr, /npm run setup/);
    });

    for (const [label, args, service] of [
        ['the Node server', [], 'starter-crm'],
        ['the Python server', ['--profile', 'python'], 'starter-crm-python']
    ]) {
        it('builds and serves ' + label + ' with secrets from files', async () => {
            const up = compose([...args, 'up', '--build', '--detach', '--wait', '--wait-timeout', '120', service]);
            assert.equal(up.status, 0, 'compose up failed:\n' + up.stdout + up.stderr);
            try {
                const base = 'http://127.0.0.1:' + port;
                // Both servers use the same port in turn; a kept-alive connection would still point at the first.
                const get = (route) => fetch(base + route, { headers: { connection: 'close' } });
                const config = await (await get('/api/config')).json();
                assert.equal(config.site_id, siteId, 'the site id came from compose');
                assert.equal((await get('/healthz')).status, 200);

                const id = compose([...args, 'ps', '--quiet', service]).stdout.trim();
                const inspected = JSON.parse(spawnSync('docker', ['inspect', id], { encoding: 'utf8' }).stdout)[0];
                const env = inspected.Config.Env.join('\n');
                for (const value of Object.values(secretValues)) {
                    assert.ok(!env.includes(value), 'a secret is in the container environment');
                }
                assert.equal(inspected.HostConfig.ReadonlyRootfs, true, 'the root filesystem should be read-only');
                assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);

                const logs = compose([...args, 'logs', '--no-color', service]);
                for (const value of Object.values(secretValues)) {
                    assert.ok(!(logs.stdout + logs.stderr).includes(value), 'a secret was logged');
                }
            } finally {
                compose([...args, 'down', '--timeout', '3']);
            }
        });

        it('keeps ' + label + "'s events in the data volume when the container is replaced", async () => {
            const base = 'http://127.0.0.1:' + port;
            const eventId = crypto.randomUUID();
            const body = JSON.stringify({ event_id: eventId, event: 'contact.msg.received', event_at: Date.now(), data: { contact_id: crypto.randomUUID() } });
            const timestamp = String(Math.floor(Date.now() / 1000));
            const signature = 'sha256=' + crypto.createHmac('sha256', secretValues.DROPCOWBOY_WEBHOOK_SECRET).update(timestamp + '.' + body).digest('hex');
            const sync = { connection: 'close' };

            // The passcode session cookie, sent by hand because it is __Host- prefixed (HTTPS only) in a production image.
            async function cookie() {
                const res = await fetch(base + '/api/auth/passcode', {
                    method: 'POST',
                    headers: { ...sync, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
                    body: JSON.stringify({ passcode: secretValues.DC_PASSCODE })
                });
                assert.equal(res.status, 200);
                return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
            }

            const first = compose([...args, 'up', '--build', '--detach', '--wait', '--wait-timeout', '120', service]);
            assert.equal(first.status, 0, 'compose up failed:\n' + first.stdout + first.stderr);
            try {
                const delivered = await fetch(base + '/webhooks/dropcowboy', {
                    method: 'POST',
                    headers: { ...sync, 'content-type': 'application/json', 'x-signature': signature, 'x-timestamp': timestamp, 'x-signature-version': 'v1' },
                    body
                });
                assert.equal(delivered.status, 200);
                // A new container, not a restart: the old one and its writable layer are gone, only the volume remains.
                assert.equal(compose([...args, 'down', '--timeout', '5']).status, 0);
                const second = compose([...args, 'up', '--detach', '--wait', '--wait-timeout', '120', service]);
                assert.equal(second.status, 0, 'compose up failed:\n' + second.stdout + second.stderr);

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 15000);
                const res = await fetch(base + '/api/events', { headers: { ...sync, cookie: await cookie() }, signal: controller.signal });
                assert.equal(res.status, 200);
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let seen = '';
                while (!seen.includes('event: replayed')) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    seen += decoder.decode(chunk.value, { stream: true });
                }
                clearTimeout(timer);
                controller.abort();
                assert.ok(seen.includes(eventId), 'the event was lost when the container was replaced:\n' + seen);
            } finally {
                compose([...args, 'down', '--volumes', '--timeout', '3']);
            }
        });
    }

    describe('compose.yaml with Redis and a separate worker', () => {
        for (const [label, args, web, worker] of [
            ['Node', ['--profile', 'redis'], 'starter-crm', 'starter-crm-worker'],
            ['Python', ['--profile', 'python', '--profile', 'python-redis'], 'starter-crm-python', 'starter-crm-python-worker']
        ]) {
            it('finishes a webhook in the ' + label + ' worker container and shows it on the web container', async () => {
                const env = { DC_STORE: 'redis', DC_DATA: 'sqlite', DC_REDIS_URL: 'redis://redis:6379', DC_WORKER_IN_PROCESS: 'off', DC_INSECURE_PRIVATE_SERVICES: 'on' };
                const base = 'http://127.0.0.1:' + port;
                const eventId = crypto.randomUUID();
                const body = JSON.stringify({ event_id: eventId, event: 'contact.msg.received', event_at: Date.now(), data: { contact_id: crypto.randomUUID() } });
                const timestamp = String(Math.floor(Date.now() / 1000));
                const signature = 'sha256=' + crypto.createHmac('sha256', secretValues.DROPCOWBOY_WEBHOOK_SECRET).update(timestamp + '.' + body).digest('hex');
                const sync = { connection: 'close' };

                const up = compose([...args, 'up', '--build', '--detach', '--wait', '--wait-timeout', '180', web, worker, 'redis'], env);
                assert.equal(up.status, 0, 'compose up failed:\n' + up.stdout + up.stderr);
                try {
                    const delivered = await fetch(base + '/webhooks/dropcowboy', {
                        method: 'POST',
                        headers: { ...sync, 'content-type': 'application/json', 'x-signature': signature, 'x-timestamp': timestamp, 'x-signature-version': 'v1' },
                        body
                    });
                    assert.equal(delivered.status, 200);

                    const login = await fetch(base + '/api/auth/passcode', {
                        method: 'POST',
                        headers: { ...sync, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
                        body: JSON.stringify({ passcode: secretValues.DC_PASSCODE })
                    });
                    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 20000);
                    const res = await fetch(base + '/api/events', { headers: { ...sync, cookie }, signal: controller.signal });
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let seen = '';
                    // The web container has its worker off, so only the worker container can have finished it.
                    while (!seen.includes(eventId)) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        seen += decoder.decode(chunk.value, { stream: true });
                    }
                    clearTimeout(timer);
                    controller.abort();
                    assert.ok(seen.includes(eventId), 'the worker container never finished the event');
                    const workerLogs = compose([...args, 'logs', '--no-color', worker], env);
                    assert.ok(!workerLogs.stdout.includes(secretValues.DROPCOWBOY_WEBHOOK_SECRET), 'the worker logged a secret');
                } finally {
                    compose([...args, 'down', '--volumes', '--timeout', '3'], env);
                }
            });
        }
    });
});
