#!/usr/bin/env node
/**
 * `npm run test:live`: the Playwright specs, run against a real Drop Cowboy
 * account (plan section 10.1).
 *
 * Where it sits: this script is the entry point. It checks the credentials,
 * reports any records an earlier run left behind, runs the same specs that
 * `npm test` runs with the `target` fixture set to `live`, then deletes
 * whatever the run created and proves none is left.
 *
 * Credentials: STARTER_CRM_LIVE_API_KEY, STARTER_CRM_LIVE_API_SECRET and
 * STARTER_CRM_LIVE_SITE_ID, from the environment or a git-ignored `.env.live`.
 * They belong to a dedicated test team; never point this at a team whose
 * data you care about. Nothing is sent to a real number, no number is rented
 * and nothing is bought: specs that would are tagged @fake-only and skipped.
 *
 * Options: `--project react` runs one front-end (default: both),
 * `--grep <text>` and `--workers <n>` pass through to Playwright. Anything
 * after `--` goes to Playwright unchanged.
 *
 * Customers run this against their own account; the specs they run are the
 * ones in tests/e2e/specs.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveApi, RUN_ID_PATTERN, liveCredentials, loadDotEnv } from './lib/live-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(root, '.env.live'));

const credentials = liveCredentials();
if (!credentials) {
    console.error('test:live: credentials not set.');
    console.error('Set STARTER_CRM_LIVE_API_KEY, STARTER_CRM_LIVE_API_SECRET and STARTER_CRM_LIVE_SITE_ID');
    console.error('(Runtime Secrets in CI, or a git-ignored .env.live). The live run is blocked until they exist.');
    process.exit(2);
}

const args = process.argv.slice(2);
const projects = args.includes('--project') ? [args[args.indexOf('--project') + 1]] : ['vanilla', 'react'];
const passthrough = args.filter((arg, i) => !['--project'].includes(arg) && args[i - 1] !== '--project');

const runId = 'live-' + crypto.randomUUID().slice(0, 8);
const api = new LiveApi(credentials);
console.log('test:live run_id=' + runId);

// Report what an earlier run left behind. Older leftovers are the sweep's job
// (npm run test:live:sweep); this run never touches another run's records.
const leftovers = (await api.findContacts('live-')).filter((c) => RUN_ID_PATTERN.test(c.name));
console.log('start state: ' + leftovers.length + ' contact(s) from earlier runs are still in the test team'
    + (leftovers.length ? ' (npm run test:live:sweep removes them)' : ''));

const cloudflared = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
const env = Object.assign({}, process.env, {
    STARTER_CRM_LIVE: '1',
    STARTER_CRM_LIVE_RUN_ID: runId,
    DROPCOWBOY_API_KEY: credentials.apiKey,
    DROPCOWBOY_API_SECRET: credentials.apiSecret,
    DROPCOWBOY_SITE_ID: credentials.siteId,
    DROPCOWBOY_API_BASE: credentials.apiBase,
    DC_AUTH_MODE: 'server',
    DC_ENV: 'development',
    DC_IDENTITY: 'dev',
    STARTER_CRM_USER_ID: credentials.userId,
    // Evidence for the PR: a video and a trace of every test.
    PLAYWRIGHT_VIDEO: 'on',
    PLAYWRIGHT_TRACE: 'on'
});
// The team's own AWS credentials belong to other work. Nothing started here
// may pick them up.
for (const name of Object.keys(env)) {
    if (/AWS/i.test(name)) delete env[name];
}
if (cloudflared.status !== 0) {
    console.warn('cloudflared is not on PATH; the webhook specs cannot run through a tunnel.');
    env.STARTER_CRM_LIVE_NO_TUNNEL = '1';
} else {
    console.log('cloudflared: ' + (cloudflared.stdout || cloudflared.stderr || '').trim().split('\n')[0]);
}

const playwrightArgs = ['playwright', 'test', '--workers=1'].concat(projects.map((p) => '--project=' + p), passthrough);
const code = await new Promise((resolve) => {
    const child = spawn('npx', playwrightArgs, { cwd: path.join(root, 'tests/e2e'), stdio: 'inherit', env });
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
});

// A crashed worker cannot clean up after itself, so this process does.
let removed = [];
let remaining = [];
try {
    removed = await api.deleteRunContacts({ runId });
    remaining = (await api.findContacts(runId)).filter((c) => c.name.includes(runId));
} catch (err) {
    console.error('test:live: cleanup failed: ' + err.message);
}
console.log('teardown: ' + removed.length + ' contact(s) left for the final sweep, ' + remaining.length + ' still in the test team');
process.exit(code === 0 && remaining.length === 0 ? 0 : (code || 1));
