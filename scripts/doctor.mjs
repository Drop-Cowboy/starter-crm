#!/usr/bin/env node
/**
 * `npm run doctor` — checks config, API reachability, CDN SRI, a signed
 * self-webhook, DC_PUBLIC_URL, this server's webhook registration, and failed webhook handlers.
 *
 * Where it sits: starter root. Read-only against Drop Cowboy except a local
 * POST to this server's /webhooks/dropcowboy when the server is up.
 *
 * Plan section 8.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadDotEnv(path.join(root, '.env'));

const { loadConfig } = await import(pathToFileURL(path.join(root, 'server/node/src/config.js')).href);
const { judgeRegistration, webhooksOf } = await import(pathToFileURL(path.join(root, 'scripts/lib/webhook-check.mjs')).href);
const { formatProblems } = await import(pathToFileURL(path.join(root, 'server/node/src/problems.js')).href);
const { CDN_ORIGIN, DEFAULT_CDN_VERSION } = await import(pathToFileURL(path.join(root, 'shared/config.js')).href);
const { config, problems } = loadConfig(process.env, root);

let failed = 0;
function warn(label, detail) {
    console.log('WARN ' + label + (detail ? ': ' + detail : ''));
}
function ok(label) {
    console.log('ok  ' + label);
}
function bad(label, detail) {
    failed += 1;
    console.error('FAIL ' + label + (detail ? ': ' + detail : ''));
}

if (problems.length) {
    bad('config', '\n' + formatProblems(problems));
} else {
    ok('config');
}

const apiBase = (config.apiBase || 'https://api-v2.dropcowboy.com').replace(/\/+$/, '');
try {
    const res = await fetch(apiBase + '/healthz', {
        signal: AbortSignal.timeout(config.timeoutMs || 10000)
    }).catch((err) => ({ ok: false, status: 0, error: err }));
    if (res && (res.status || res.error)) ok('api base reachable (' + (res.status || res.error.message) + ')');
    else bad('api base reachable', apiBase);
} catch (err) {
    bad('api base reachable', err.message);
}

const cdnVersion = String(config.cdnVersion || DEFAULT_CDN_VERSION).trim().replace(/^v/, '');
const manifestUrl = CDN_ORIGIN + '/v' + cdnVersion + '/building-blocks-manifest.json';
try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) bad('CDN SRI manifest', manifestUrl + ' → ' + res.status);
    else {
        const body = await res.json();
        if (!body || typeof body !== 'object') bad('CDN SRI manifest', 'not a JSON object');
        else ok('CDN SRI manifest v' + cdnVersion);
    }
} catch (err) {
    bad('CDN SRI manifest', err.message);
}

if (config.publicUrl) {
    try {
        const res = await fetch(config.publicUrl.replace(/\/+$/, '') + '/healthz', {
            signal: AbortSignal.timeout(10000)
        });
        if (res.ok) ok('DC_PUBLIC_URL /healthz');
        else bad('DC_PUBLIC_URL /healthz', String(res.status));
    } catch (err) {
        bad('DC_PUBLIC_URL /healthz', err.message);
    }
} else {
    console.log('skip DC_PUBLIC_URL (unset)');
}

if (config.mode === 'server' && config.apiKey && config.apiSecret) {
    try {
        const res = await fetch(apiBase + '/register/public/webhooks', {
            headers: { 'x-key': config.apiKey, 'x-secret': config.apiSecret },
            signal: AbortSignal.timeout(config.timeoutMs || 10000)
        });
        if (res.status === 401) {
            bad('API key', 'Drop Cowboy rejected DROPCOWBOY_API_KEY and DROPCOWBOY_API_SECRET (401). Copy both again from Developers > API Keys.');
        } else if (res.status === 403) {
            warn('webhook registration', 'the API key lacks webhooks:read, so doctor cannot list webhooks');
        } else if (!res.ok) {
            warn('webhook registration', 'GET /register/public/webhooks answered ' + res.status);
        } else {
            const verdict = judgeRegistration(webhooksOf(await res.json()), config.publicUrl);
            if (verdict.state === 'ok') ok('webhook registration: ' + verdict.message);
            else warn('webhook registration', verdict.message);
        }
    } catch (err) {
        warn('webhook registration', err.message);
    }
} else {
    console.log('skip webhook registration (needs server mode with an API key)');
}

await checkEventStore();

const local = 'http://' + (config.host || '127.0.0.1') + ':' + (config.port || 8080);
const secret = (config.webhookSecrets && config.webhookSecrets[0]) || '';
if (!secret) {
    console.log('skip self-webhook (DROPCOWBOY_WEBHOOK_SECRET unset)');
} else {
    try {
        const health = await fetch(local + '/healthz', { signal: AbortSignal.timeout(2000) });
        if (!health.ok) throw new Error('server not up on ' + local);
        const eventId = crypto.randomUUID();
        const body = JSON.stringify({
            event_id: eventId,
            event: 'contact.created',
            event_at: Date.now(),
            data: { contact_id: crypto.randomUUID(), phone: '+15550100100', email: 'ada@example.com' }
        });
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
        const res = await fetch(local + '/webhooks/dropcowboy', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'X-Signature': sig,
                'X-Timestamp': ts,
                'X-Signature-Version': 'v1',
                'X-Event-Id': eventId
            },
            body,
            signal: AbortSignal.timeout(5000)
        });
        if (res.status >= 200 && res.status < 300) ok('signed self-webhook');
        else bad('signed self-webhook', 'status ' + res.status + ' ' + await res.text());
    } catch (err) {
        bad('signed self-webhook', err.message + ' (is npm start running?)');
    }
}

process.exit(failed ? 1 : 0);

/**
 * Reads the event store the way the server would and reports failed and stuck events.
 * A memory store lives inside the server process, so there is nothing to read from here.
 */
async function checkEventStore() {
    if (problems.length > 0) return;
    if (config.events.store === 'memory') {
        console.log('skip event store (DC_STORE=memory lives inside the server; the Setup page shows its counts)');
        return;
    }
    const { bootstrap } = await import(pathToFileURL(path.join(root, 'server/node/src/bootstrap.js')).href);
    let booted;
    try {
        booted = await bootstrap(process.env, root);
        if (booted.problems.length > 0) {
            bad('event store', '\n' + formatProblems(booted.problems));
            return;
        }
        const counts = await booted.runtime.store.counts();
        const summary = counts.processed + ' handled, ' + counts.received + ' waiting, ' + counts.failed + ' failed';
        if (counts.failed > 0) {
            bad('event store', summary + '. Run "npm run webhooks:failed", then "npm run webhooks:replay -- <event_id>".');
        } else if (counts.received > 0 && counts.oldest_received_age_seconds >= 300) {
            bad('event store', summary + '; the oldest has waited ' + Math.floor(counts.oldest_received_age_seconds / 60) + ' minutes. Is a worker running?');
        } else {
            ok('event store (' + config.events.store + '): ' + summary);
        }
    } catch (err) {
        bad('event store', err.message);
    } finally {
        if (booted && booted.runtime) await booted.runtime.stop();
    }
}

/** Minimal .env loader: KEY=VALUE lines; does not override existing env. */
function loadDotEnv(file) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
    }
}
