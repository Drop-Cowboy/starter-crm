#!/usr/bin/env node
/**
 * `npm run test:live:sweep`: removes what `npm run test:live` left behind.
 *
 * Where it sits: a clean test run deletes everything it made, so this only
 * matters after a crash or a killed run. It deletes
 *   - contacts whose name carries a run id (`live-` and 8 hex digits) and that
 *     were created more than a day ago (`--all` ignores the age), and
 *   - the webhook of any run whose state file is still in `.live-state/`,
 *     deleted by id (the E2E key can delete a webhook but not list them).
 *
 * Credentials: the same STARTER_CRM_LIVE_* as test:live.
 *
 * Customers do not change this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveApi, liveCredentials, liveStateDir, loadDotEnv } from './lib/live-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(root, '.env.live'));

const credentials = liveCredentials();
if (!credentials) {
    console.error('test:live:sweep: credentials not set (STARTER_CRM_LIVE_API_KEY, STARTER_CRM_LIVE_API_SECRET, STARTER_CRM_LIVE_SITE_ID).');
    process.exit(2);
}

const all = process.argv.includes('--all');
const api = new LiveApi(credentials);
const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

const removed = await api.deleteRunContacts({ olderThanMs: all ? 0 : dayAgo });
for (const contact of removed) console.log('deleted contact ' + contact.contact_id + ' (' + contact.name + ')');

const stateDir = liveStateDir(root);
let webhooks = 0;
if (fs.existsSync(stateDir)) {
    for (const file of fs.readdirSync(stateDir)) {
        const state = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
        // A run that is still going has a fresh state file; leave it alone.
        if (!all && Date.now() - state.created_at < 60 * 60 * 1000) continue;
        await api.deleteWebhook(state.webhook_id);
        fs.rmSync(path.join(stateDir, file), { force: true });
        webhooks += 1;
        console.log('deleted webhook ' + state.webhook_id + ' (run ' + state.run_id + ')');
    }
}
console.log('sweep done: ' + removed.length + ' contact(s), ' + webhooks + ' webhook(s) removed');
