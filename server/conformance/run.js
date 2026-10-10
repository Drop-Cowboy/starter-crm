#!/usr/bin/env node
// Boots a mock Drop Cowboy API and one copy of the server under test per auth
// mode, runs the suite against them, then shuts everything down.
//
//   node run.js                                                   # Node server
//   SERVER_CMD="python -m starter_crm" SERVER_CWD=../python node run.js   # Python server

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnv, freePort, spawnServer, stopServer, waitForHealth } from './lib/process.js';
import { MOCK_TOKEN, startMock } from './mock-upstream.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverCmd = process.env.SERVER_CMD || 'node src/index.js';
const serverCwd = process.env.SERVER_CWD ? path.resolve(process.env.SERVER_CWD) : path.join(here, '..', 'node');
const timeoutMs = 1500;

const secrets = {
    apiKey: 'conformance-key-' + crypto.randomUUID(),
    apiSecret: 'conformance-secret-' + crypto.randomUUID(),
    webhookSecret: 'conformance-webhook-' + crypto.randomUUID(),
    webhookSecret2: 'conformance-webhook-' + crypto.randomUUID(),
    // Login-mode access tokens, deliberately not JWT-shaped, so only "never
    // log it" keeps them out of the output. The mock accepts the first one.
    accessToken: 'conformance-access-' + crypto.randomUUID(),
    expiredAccessToken: 'conformance-expired-' + crypto.randomUUID()
};
const siteId = crypto.randomUUID();
const userId = crypto.randomUUID();

const mock = await startMock({
    slowDelayMs: timeoutMs * 3,
    apiKey: secrets.apiKey,
    apiSecret: secrets.apiSecret,
    accessTokens: [secrets.accessToken]
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-conformance-'));

// Each mode gets its own starter root, so .env, the session file and the
// front-end folders differ per server.
const modes = {
    login: {
        env: {
            DC_AUTH_MODE: 'login',
            DROPCOWBOY_SITE_ID: siteId,
            // Two subscriptions, two secrets; the space checks trimming.
            DROPCOWBOY_WEBHOOK_SECRET: secrets.webhookSecret + ', ' + secrets.webhookSecret2,
            AUTH0_CLIENT_ID: 'conformance-public-client-id',
            DC_CDN_VERSION: '1.2.3'
        },
        files: {
            'vanilla/index.html': '<!doctype html><title>vanilla</title><!-- conformance-vanilla-index -->',
            'vanilla/app.js': 'console.log("conformance-vanilla-asset");\n',
            'react/dist/index.html': '<!doctype html><title>react</title><!-- conformance-react-index -->',
            'shared/dc-api.js': 'export const marker = "conformance-shared-module";\n',
            'shared/lib/format.mjs': 'export const marker = "conformance-shared-nested";\n',
            'shared/index.html': '<!doctype html><!-- conformance-shared-index -->',
            'shared/.hidden.js': 'export const marker = "conformance-shared-dotfile";\n'
        }
    },
    server: {
        env: {
            DC_AUTH_MODE: 'server',
            DROPCOWBOY_API_KEY: secrets.apiKey,
            DROPCOWBOY_API_SECRET: secrets.apiSecret,
            DROPCOWBOY_SITE_ID: siteId,
            DROPCOWBOY_WEBHOOK_SECRET: secrets.webhookSecret,
            STARTER_CRM_USER_ID: userId
        },
        files: {}
    },
    'mcp-session': {
        env: { DC_AUTH_MODE: 'mcp-session' },
        files: {
            '.dropcowboy/.keep': '',
            'shared/dc-api.js': 'export const marker = "conformance-shared-module";\n'
        }
    }
};

const servers = {};
const procs = [];
let exitCode = 1;

try {
    for (const [mode, setup] of Object.entries(modes)) {
        const root = path.join(tmp, mode);
        const env = {
            ...setup.env,
            DROPCOWBOY_API_BASE: mock.url,
            DROPCOWBOY_TIMEOUT_MS: String(timeoutMs)
        };
        writeFiles(root, { ...setup.files, '.env': toDotenv(env) });

        const port = await freePort();
        const proc = spawnServer({
            command: serverCmd,
            cwd: serverCwd,
            env: { ...baseEnv(), STARTER_CRM_ROOT: root, HOST: '127.0.0.1', PORT: String(port) }
        });
        procs.push(proc);
        servers[mode] = { url: 'http://127.0.0.1:' + port, root };
    }

    console.log('Server under test: ' + serverCmd + '  (cwd ' + serverCwd + ')');
    await Promise.all(Object.keys(servers).map((mode, i) => waitForHealth(servers[mode].url, procs[i])));

    const context = { mock: mock.url, servers, secrets, siteId, userId, serverCmd, serverCwd, timeoutMs };
    const suiteDir = path.join(here, 'suite');
    const files = fs.readdirSync(suiteDir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(suiteDir, f));
    const suiteCode = await runSuite(files, context);

    const leaks = findLeaks(procs.map((p) => p.output()).join('\n'));
    if (leaks.length) {
        console.error('\nFAIL: server output contains ' + leaks.join(', ') + '. Secrets and tokens must never be logged.');
    }
    exitCode = suiteCode === 0 && leaks.length === 0 ? 0 : 1;
} catch (err) {
    console.error(err.message || err);
} finally {
    await Promise.all(procs.map(stopServer));
    await mock.close();
    if (exitCode !== 0) {
        for (let i = 0; i < procs.length; i++) {
            console.error('\n--- server output (DC_AUTH_MODE=' + Object.keys(modes)[i] + ') ---\n' + procs[i].output());
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);

function runSuite(files, context) {
    return new Promise((resolve) => {
        // --test-force-exit: idle keep-alive sockets would otherwise hold each
        // test file open for several seconds after its last test.
        const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', '--test-reporter=spec', ...files], {
            stdio: 'inherit',
            env: { ...process.env, CONFORMANCE_CONTEXT: JSON.stringify(context) }
        });
        child.on('exit', (code) => resolve(code === null ? 1 : code));
    });
}

function findLeaks(output) {
    const leaks = [];
    if (output.includes(secrets.apiKey)) leaks.push('DROPCOWBOY_API_KEY');
    if (output.includes(secrets.apiSecret)) leaks.push('DROPCOWBOY_API_SECRET');
    if (output.includes(secrets.webhookSecret) || output.includes(secrets.webhookSecret2)) leaks.push('DROPCOWBOY_WEBHOOK_SECRET');
    if (output.includes(MOCK_TOKEN)) leaks.push('a site token');
    if (output.includes(secrets.accessToken) || output.includes(secrets.expiredAccessToken)) leaks.push('a login access token');
    return leaks;
}

function writeFiles(root, files) {
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
}

function toDotenv(env) {
    return Object.entries(env).map(([key, value]) => key + '=' + value).join('\n') + '\n';
}
