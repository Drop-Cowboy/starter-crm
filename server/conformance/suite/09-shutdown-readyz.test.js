/**
 * Conformance: GET /readyz and SIGTERM with an open SSE stream.
 *
 * CONTRACT.md: GET /readyz, Shutdown.
 * Protects: load balancers must see 503 while draining; deploys must not hang
 * on open event streams past DC_SHUTDOWN_GRACE_SECONDS.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { call, ctx } from '../lib/context.js';
import { baseEnv, freePort, spawnServer, stopServer, waitForHealth } from '../lib/process.js';

describe('GET /readyz', () => {
    it('answers {"ok": true} while the server is up', async () => {
        const res = await call('server', '/readyz');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { ok: true });
    });
});

describe('shutdown with an open event stream', () => {
    it('exits within DC_SHUTDOWN_GRACE_SECONDS after SIGTERM', async () => {
        const port = await freePort();
        const grace = 3;
        const env = {
            ...baseEnv(),
            DC_AUTH_MODE: 'server',
            DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
            DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
            DROPCOWBOY_SITE_ID: crypto.randomUUID(),
            STARTER_CRM_USER_ID: ctx.userId,
            DROPCOWBOY_API_BASE: ctx.mock,
            HOST: '127.0.0.1',
            PORT: String(port),
            DC_SHUTDOWN_GRACE_SECONDS: String(grace)
        };
        const proc = spawnServer({ command: ctx.serverCmd, cwd: ctx.serverCwd, env });
        const url = 'http://127.0.0.1:' + port;
        try {
            await waitForHealth(url, proc);
            // Open an SSE stream and leave it hanging.
            const controller = new AbortController();
            const stream = fetch(url + '/api/events', { signal: controller.signal });
            // Give the server a moment to register the stream.
            await new Promise((resolve) => setTimeout(resolve, 200));
            const started = Date.now();
            // SIGTERM the process group.
            try {
                process.kill(-proc.child.pid, 'SIGTERM');
            } catch {
                proc.child.kill('SIGTERM');
            }
            const result = await Promise.race([
                proc.exited,
                new Promise((resolve) => setTimeout(() => resolve('timeout'), (grace + 5) * 1000))
            ]);
            const elapsed = Date.now() - started;
            controller.abort();
            try { await stream; } catch { /* aborted */ }
            assert.notEqual(result, 'timeout', 'server did not exit after SIGTERM with an open stream\n' + proc.output());
            assert.ok(elapsed <= (grace + 2) * 1000,
                'exit took ' + elapsed + ' ms, longer than grace ' + grace + 's (+2s slack)\n' + proc.output());
        } finally {
            await stopServer(proc);
        }
    });
});
