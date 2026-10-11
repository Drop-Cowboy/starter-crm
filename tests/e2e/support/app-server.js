import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnv, freePort, spawnServer, stopServer, waitForHealth } from '../../../server/conformance/lib/process.js';
import { STARTER_CRM_USER_ID, SITE_ID } from './data.js';

// Starts one starter server: Node by default, or whatever SERVER_CMD and
// SERVER_CWD name (the same variables the conformance suite uses):
//
//   SERVER_CMD="python -m starter_crm" SERVER_CWD=../../server/python npx playwright test
//
// Each server gets its own starter root in a temp folder, holding a copy of
// the front-ends and a .env pointing at the fake Drop Cowboy.

const here = path.dirname(fileURLToPath(import.meta.url));
export const STARTER_ROOT = path.resolve(here, '..', '..', '..');

export function serverUnderTest() {
    return {
        command: process.env.SERVER_CMD || 'node src/index.js',
        cwd: process.env.SERVER_CWD ? path.resolve(process.env.SERVER_CWD) : path.join(STARTER_ROOT, 'server', 'node')
    };
}

/** The .env each auth mode runs with. */
function envFor(mode, { fakeUrl, secrets }) {
    const common = { DROPCOWBOY_API_BASE: fakeUrl, DROPCOWBOY_WEBHOOK_SECRET: secrets.webhookSecret };
    if (mode === 'server') {
        return {
            ...common,
            DC_AUTH_MODE: 'server',
            DROPCOWBOY_API_KEY: secrets.apiKey,
            DROPCOWBOY_API_SECRET: secrets.apiSecret,
            DROPCOWBOY_SITE_ID: SITE_ID,
            STARTER_CRM_USER_ID
        };
    }
    if (mode === 'login') {
        return { ...common, DC_AUTH_MODE: 'login', DROPCOWBOY_SITE_ID: SITE_ID, AUTH0_CLIENT_ID: secrets.loginClientId };
    }
    if (mode === 'login-not-configured') {
        return { ...common, DC_AUTH_MODE: 'login', DROPCOWBOY_SITE_ID: SITE_ID };
    }
    if (mode === 'mcp-session') {
        return { DC_AUTH_MODE: 'mcp-session' };
    }
    throw new Error('Unknown server mode: ' + mode);
}

export async function startAppServer({ mode, ui, fakeUrl, secrets }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-e2e-'));
    copyFrontEnds(root, ui);
    const env = envFor(mode, { fakeUrl, secrets });
    fs.writeFileSync(path.join(root, '.env'),
        Object.entries(env).map(([key, value]) => key + '=' + value).join('\n') + '\n');

    const { command, cwd } = serverUnderTest();
    const port = await freePort();
    const proc = spawnServer({
        command,
        cwd,
        env: { ...baseEnv(), STARTER_CRM_ROOT: root, HOST: '127.0.0.1', PORT: String(port) }
    });
    const url = 'http://127.0.0.1:' + port;
    await waitForHealth(url, proc);

    return {
        url,
        root,
        output: proc.output,
        async stop() {
            await stopServer(proc);
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function copyFrontEnds(root, ui) {
    const skip = (src) => !/[\\/](node_modules|test|tests)([\\/]|$)/.test(src.slice(STARTER_ROOT.length));
    fs.cpSync(path.join(STARTER_ROOT, 'shared'), path.join(root, 'shared'), { recursive: true, filter: skip });
    fs.cpSync(path.join(STARTER_ROOT, 'vanilla'), path.join(root, 'vanilla'), { recursive: true, filter: skip });
    if (ui === 'react') {
        const dist = path.join(STARTER_ROOT, 'react', 'dist');
        if (!fs.existsSync(path.join(dist, 'index.html'))) {
            throw new Error('react/dist is missing. Build the React app first: (cd react && npm install && npm run build)');
        }
        fs.cpSync(dist, path.join(root, 'react', 'dist'), { recursive: true });
    }
}
