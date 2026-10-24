#!/usr/bin/env node
/**
 * `npm run webhook:test -- contact.created` — posts a signed fictional event
 * to the local server. No tunnel needed.
 *
 * Where it sits: starter root. Uses DROPCOWBOY_WEBHOOK_SECRET from .env.
 * Plan section 8.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const type = process.argv[2] || 'contact.created';

loadDotEnv(path.join(root, '.env'));
const { loadConfig } = await import(pathToFileURL(path.join(root, 'server/node/src/config.js')).href);
const { config, problems } = loadConfig(process.env, root);
if (problems.length) {
    console.error('Config invalid. Run npm run doctor.');
    process.exit(1);
}

const secret = config.webhookSecrets[0];
if (!secret) {
    console.error('Set DROPCOWBOY_WEBHOOK_SECRET in .env first.');
    process.exit(1);
}

const eventId = crypto.randomUUID();
const contactId = crypto.randomUUID();
const body = JSON.stringify({
    event_id: eventId,
    event: type,
    event_at: Date.now(),
    data: {
        contact_id: contactId,
        phone: '+15550100142',
        email: 'ada@example.com',
        first_name: 'Ada',
        last_name: 'Lovelace'
    }
});
const ts = String(Math.floor(Date.now() / 1000));
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
const url = 'http://' + config.host + ':' + config.port + '/webhooks/dropcowboy';

const res = await fetch(url, {
    method: 'POST',
    headers: {
        'content-type': 'application/json',
        'X-Signature': sig,
        'X-Timestamp': ts,
        'X-Signature-Version': 'v1',
        'X-Event-Id': eventId
    },
    body
});
const text = await res.text();
console.log(res.status, text);
console.log('event_id=' + eventId + ' contact_id=' + contactId);
if (res.status < 200 || res.status >= 300) process.exit(1);

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
