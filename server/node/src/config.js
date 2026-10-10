import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = ['login', 'server', 'mcp-session'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_ID_NOT_UUID = 'DROPCOWBOY_SITE_ID must be a UUID such as 3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d '
    + '(generate one with `node -e "console.log(crypto.randomUUID())"`). Drop Cowboy rejects any other site_id with 400 invalid_site_id.';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function starterRoot(env) {
    return read(env, 'STARTER_CRM_ROOT') || DEFAULT_ROOT;
}

// Returns { config, problems }. A non-empty `problems` means the server must
// not start; index.js prints them and exits.
export function loadConfig(env, root = starterRoot(env)) {
    const problems = [];

    const mode = read(env, 'DC_AUTH_MODE') || 'server';
    if (!MODES.includes(mode)) {
        problems.push('DC_AUTH_MODE must be one of ' + MODES.join(', ') + ' (got "' + mode + '").');
    }

    const apiBase = (read(env, 'DROPCOWBOY_API_BASE') || 'https://api-v2.dropcowboy.com').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+/.test(apiBase)) {
        problems.push('DROPCOWBOY_API_BASE must be an http(s) URL.');
    }

    const port = Number(read(env, 'PORT') || 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        problems.push('PORT must be a whole number between 0 and 65535.');
    }

    const timeoutMs = Number(read(env, 'DROPCOWBOY_TIMEOUT_MS') || 10000);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        problems.push('DROPCOWBOY_TIMEOUT_MS must be a positive whole number of milliseconds.');
    }

    const config = {
        mode,
        root,
        host: read(env, 'HOST') || '127.0.0.1',
        port,
        apiBase,
        timeoutMs,
        apiKey: read(env, 'DROPCOWBOY_API_KEY'),
        apiSecret: read(env, 'DROPCOWBOY_API_SECRET'),
        siteId: read(env, 'DROPCOWBOY_SITE_ID'),
        // One secret per webhook, so a comma-separated list.
        webhookSecrets: (read(env, 'DROPCOWBOY_WEBHOOK_SECRET') || '').split(',').map((s) => s.trim()).filter(Boolean),
        starterUserId: read(env, 'STARTER_CRM_USER_ID'),
        cdnVersion: read(env, 'DC_CDN_VERSION'),
        auth0: {
            domain: read(env, 'AUTH0_DOMAIN') || 'login.dropcowboy.com',
            clientId: read(env, 'AUTH0_CLIENT_ID'),
            audience: read(env, 'AUTH0_AUDIENCE') || 'https://api-v2.dropcowboy.com'
        }
    };

    // Checked in every mode: login mode hands site_id to the browser and
    // mcp-session falls back to it, and Drop Cowboy answers 400 invalid_site_id.
    if (config.siteId && !UUID.test(config.siteId)) {
        problems.push(SITE_ID_NOT_UUID);
    }

    // Both modes that mint send it with every mint.
    if ((mode === 'server' || mode === 'login') && !config.siteId) {
        problems.push('DROPCOWBOY_SITE_ID is required when DC_AUTH_MODE=' + mode + '.');
    }

    if (mode === 'server') {
        if (!config.apiKey) problems.push('DROPCOWBOY_API_KEY is required when DC_AUTH_MODE=server.');
        if (!config.apiSecret) problems.push('DROPCOWBOY_API_SECRET is required when DC_AUTH_MODE=server.');
        if (!config.starterUserId) {
            problems.push('STARTER_CRM_USER_ID is required when DC_AUTH_MODE=server (it stands in for your signed-in user).');
        } else if (!UUID.test(config.starterUserId)) {
            problems.push('STARTER_CRM_USER_ID must be a UUID.');
        }
    }

    return { config, problems };
}

// The values that must never appear in a log line or a response.
export function secretValues(config) {
    return [config.apiKey, config.apiSecret, ...config.webhookSecrets].filter(Boolean);
}

function read(env, name) {
    const value = env[name];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}
