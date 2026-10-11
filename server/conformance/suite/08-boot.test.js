import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ctx } from '../lib/context.js';
import { baseEnv, freePort, spawnServer, stopServer } from '../lib/process.js';

const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-boot-'));
after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));

// Boots the server with `env` and expects it to exit non-zero on its own.
async function bootExpectingFailure(env) {
    const port = await freePort();
    const proc = spawnServer({
        command: ctx.serverCmd,
        cwd: ctx.serverCwd,
        env: { ...baseEnv(), STARTER_CRM_ROOT: emptyRoot, HOST: '127.0.0.1', PORT: String(port), ...env }
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 20000));
    const result = await Promise.race([proc.exited, timeout]);
    await stopServer(proc);
    assert.notEqual(result, 'timeout', 'the server kept running with an invalid configuration');
    assert.notEqual(result.code, 0, 'the server must exit with a non-zero code');
    return proc.output();
}

describe('boot', () => {
    it('server mode without credentials exits and names every missing variable', async () => {
        const output = await bootExpectingFailure({ DC_AUTH_MODE: 'server' });
        for (const name of ['DROPCOWBOY_API_KEY', 'DROPCOWBOY_API_SECRET', 'DROPCOWBOY_SITE_ID', 'STARTER_CRM_USER_ID']) {
            assert.match(output, new RegExp(name), 'message should name ' + name);
        }
    });

    it('server mode with a non-UUID site id exits without printing secrets', async () => {
        const output = await bootExpectingFailure({
            DC_AUTH_MODE: 'server',
            DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
            DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
            DROPCOWBOY_SITE_ID: 'my-crm',
            STARTER_CRM_USER_ID: ctx.userId
        });
        assert.match(output, /DROPCOWBOY_SITE_ID/);
        assert.ok(!output.includes(ctx.secrets.apiKey) && !output.includes(ctx.secrets.apiSecret), 'boot output leaked a secret');
    });

    it('login mode without a site id exits and names it, but needs no API key', async () => {
        const output = await bootExpectingFailure({ DC_AUTH_MODE: 'login' });
        assert.match(output, /DROPCOWBOY_SITE_ID/);
        assert.doesNotMatch(output, /DROPCOWBOY_API_KEY|DROPCOWBOY_API_SECRET|STARTER_CRM_USER_ID/);
    });

    for (const mode of ['login', 'mcp-session']) {
        it(mode + ' mode with a non-UUID site id exits and says it must be a UUID', async () => {
            const output = await bootExpectingFailure({ DC_AUTH_MODE: mode, DROPCOWBOY_SITE_ID: 'my-crm' });
            assert.match(output, /DROPCOWBOY_SITE_ID/);
            assert.match(output, /UUID/);
        });
    }

    it('an unknown DC_AUTH_MODE exits', async () => {
        const output = await bootExpectingFailure({ DC_AUTH_MODE: 'open-to-everyone' });
        assert.match(output, /DC_AUTH_MODE/);
    });

    it('a port already in use exits with a plain message, not a stack trace', async () => {
        const blocker = net.createServer();
        await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const port = String(blocker.address().port);
        try {
            const output = await bootExpectingFailure({
                DC_AUTH_MODE: 'server',
                DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
                DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
                DROPCOWBOY_SITE_ID: crypto.randomUUID(),
                STARTER_CRM_USER_ID: ctx.userId,
                PORT: port
            });
            assert.ok(output.includes(port), 'message should name the port');
            assert.match(output, /in use/i);
            assert.doesNotMatch(output, /Traceback|TypeError|^\s+at /m);
        } finally {
            await new Promise((resolve) => blocker.close(resolve));
        }
    });
});
