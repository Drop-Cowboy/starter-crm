import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const SITE_ID = '3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d';
export const USER_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
export const API_KEY = 'unit-test-key-0001';
export const API_SECRET = 'unit-test-secret-0002';
export const WEBHOOK_SECRET = 'unit-test-webhook-secret-0003';

export function makeConfig(env = {}) {
    const { config, problems } = loadConfig({
        DC_AUTH_MODE: 'server',
        DROPCOWBOY_API_KEY: API_KEY,
        DROPCOWBOY_API_SECRET: API_SECRET,
        DROPCOWBOY_SITE_ID: SITE_ID,
        DROPCOWBOY_WEBHOOK_SECRET: WEBHOOK_SECRET,
        DROPCOWBOY_API_BASE: 'https://api.example.test',
        STARTER_CRM_USER_ID: USER_ID,
        STARTER_CRM_ROOT: '/nonexistent-starter-root',
        ...env
    });
    if (problems.length) {
        throw new Error(problems.map((p) => (typeof p === 'string' ? p : p.message)).join('; '));
    }
    return config;
}

export const silentLog = { info() {}, warn() {}, error() {} };

// Starts the app on a random loopback port and returns its base URL.
export async function startApp(config, deps = {}) {
    const app = createApp(config, { log: silentLog, ...deps });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        })
    };
}

// A fake fetch that records calls and answers with `respond(call)`.
export function fakeFetch(respond) {
    const calls = [];
    const fn = async (url, init) => {
        const call = {
            url,
            method: init.method,
            headers: init.headers,
            body: init.body ? JSON.parse(init.body) : undefined
        };
        calls.push(call);
        return respond(call);
    };
    fn.calls = calls;
    return fn;
}

export function jsonResponse(status, body, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers }
    });
}

export function sign(rawBody, secret, timestamp) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
}
