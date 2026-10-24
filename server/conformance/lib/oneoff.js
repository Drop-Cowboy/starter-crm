// Boots extra copies of the server under test for the cases that need their
// own environment: boot failures, file-based secrets, a refreshing provider.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ctx } from './context.js';
import { baseEnv, freePort, spawnServer, stopServer, waitForHealth } from './process.js';
import { extension } from './providers.js';

export const ext = extension(ctx.serverLang);

/**
 * Creates a temporary starter root holding `files`.
 *
 * @param {Record<string, string>} files Relative path to content.
 * @returns {string} The root.
 */
export function makeRoot(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-oneoff-'));
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return root;
}

/**
 * Boots the server with `env` and expects it to exit non-zero on its own.
 *
 * @param {Record<string, string>} env Variables for the server.
 * @param {string} [root] The starter root; an empty one by default.
 * @returns {Promise<string>} Everything the server printed.
 */
export async function bootFails(env, root = makeRoot()) {
    const port = await freePort();
    const proc = spawnServer({
        command: ctx.serverCmd,
        cwd: ctx.serverCwd,
        env: { ...baseEnv(), STARTER_CRM_ROOT: root, HOST: '127.0.0.1', PORT: String(port), ...env }
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 20000));
    const result = await Promise.race([proc.exited, timeout]);
    await stopServer(proc);
    if (result === 'timeout') throw new Error('the server kept running with an invalid configuration');
    if (result.code === 0) throw new Error('the server must exit with a non-zero code');
    return proc.output();
}

/**
 * Boots a long-running extra server and registers it in `ctx.servers` under
 * `name`, so `call(name, ...)` works.
 *
 * @param {string} name The mode name to register.
 * @param {Record<string, string>} env Variables for the server.
 * @param {string} [root] The starter root.
 * @returns {Promise<{ url: string, root: string, output: () => string, stop: () => Promise<void> }>} The server.
 */
export async function bootServer(name, env, root = makeRoot()) {
    const port = await freePort();
    const proc = spawnServer({
        command: ctx.serverCmd,
        cwd: ctx.serverCwd,
        env: { ...baseEnv(), STARTER_CRM_ROOT: root, HOST: '127.0.0.1', PORT: String(port), ...env }
    });
    const url = 'http://127.0.0.1:' + port;
    await waitForHealth(url, proc);
    ctx.servers[name] = { url, root };
    return {
        url,
        root,
        output: proc.output,
        stop: async () => {
            await stopServer(proc);
            delete ctx.servers[name];
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

/**
 * The variables a minimal `server`-mode server needs, pointed at the mock.
 *
 * @returns {Record<string, string>} Variables.
 */
export function serverEnv() {
    return {
        DC_AUTH_MODE: 'server',
        DROPCOWBOY_API_BASE: ctx.mock,
        DROPCOWBOY_TIMEOUT_MS: String(ctx.timeoutMs),
        DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
        DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
        DROPCOWBOY_SITE_ID: ctx.siteId,
        DROPCOWBOY_WEBHOOK_SECRET: ctx.secrets.webhookSecret,
        STARTER_CRM_USER_ID: ctx.userId
    };
}
