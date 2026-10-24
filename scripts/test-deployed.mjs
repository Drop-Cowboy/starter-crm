#!/usr/bin/env node
/**
 * `npm run test:deployed -- --url https://crm.example.com`: checks a Starter CRM
 * that is already running on a host (a container host, a sandbox AWS
 * deploy), as a visitor and as the person who set it up would see it.
 *
 * Where it sits: this script is the entry point. It sets the environment the
 * two halves read, runs the host checks (tests/deployed/host.test.js: HTTPS,
 * headers, caching, compression, a webhook acknowledged in under a second and
 * an event stream that outlives the host's idle limit), then the browser spec
 * (tests/e2e/deployed/deployed.spec.js: sign in, the app shell, a signed event
 * in the activity feed) once per front-end.
 *
 * Settings, each a flag or an environment variable:
 *
 *   --url <address>             STARTER_CRM_DEPLOYED_URL            required
 *   --passcode <passcode>       STARTER_CRM_DEPLOYED_PASSCODE       the passcode identity's passcode
 *   --webhook-secret <secret>   STARTER_CRM_DEPLOYED_WEBHOOK_SECRET a signing secret the host accepts
 *   --hold-seconds <n>          STARTER_CRM_DEPLOYED_HOLD_SECONDS   how long the event stream is held (default 75)
 *   --require-all               STARTER_CRM_DEPLOYED_REQUIRE_ALL=1  a missing setting fails instead of skipping
 *   --no-browser                                                    host checks only
 *
 * Prefer the environment variables for the passcode and the secret: a flag is
 * visible in the process list. They are never printed.
 *
 * What it sends: reads, a sign-in, and a few fictional webhook events about
 * made-up contacts (555 test numbers). It never calls Drop Cowboy and writes
 * nothing to your account, but the events do show in the host's activity feed.
 *
 * Exit code: 0 when every check passed, 1 otherwise, 2 for a usage error.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

/** The value after a flag, or the environment variable's, or ''. */
function setting(flag, variable) {
    const at = args.indexOf(flag);
    if (at !== -1) return args[at + 1] || '';
    return process.env[variable] || '';
}

const url = setting('--url', 'STARTER_CRM_DEPLOYED_URL');
if (!url) {
    console.error('test:deployed: no address given.');
    console.error('Usage: npm run test:deployed -- --url https://crm.example.com');
    console.error('Add STARTER_CRM_DEPLOYED_PASSCODE and STARTER_CRM_DEPLOYED_WEBHOOK_SECRET to run the signed-in checks.');
    process.exit(2);
}
try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
        console.error('test:deployed: ' + url + ' is not https. A deployed host must use https; only a loopback address may use http.');
        process.exit(2);
    }
} catch {
    console.error('test:deployed: ' + url + ' is not a URL.');
    process.exit(2);
}

const env = {
    ...process.env,
    STARTER_CRM_DEPLOYED_URL: url.replace(/\/+$/, ''),
    STARTER_CRM_DEPLOYED_PASSCODE: setting('--passcode', 'STARTER_CRM_DEPLOYED_PASSCODE'),
    STARTER_CRM_DEPLOYED_WEBHOOK_SECRET: setting('--webhook-secret', 'STARTER_CRM_DEPLOYED_WEBHOOK_SECRET'),
    STARTER_CRM_DEPLOYED_HOLD_SECONDS: setting('--hold-seconds', 'STARTER_CRM_DEPLOYED_HOLD_SECONDS') || '75',
    STARTER_CRM_DEPLOYED_REQUIRE_ALL: args.includes('--require-all') ? '1' : (process.env.STARTER_CRM_DEPLOYED_REQUIRE_ALL || '')
};
if (!/^\d+$/.test(env.STARTER_CRM_DEPLOYED_HOLD_SECONDS)) {
    console.error('test:deployed: --hold-seconds must be a whole number of seconds.');
    process.exit(2);
}

console.log('test:deployed ' + env.STARTER_CRM_DEPLOYED_URL);
console.log('  passcode: ' + (env.STARTER_CRM_DEPLOYED_PASSCODE ? 'given' : 'not given (signed-in checks skip)')
    + ', webhook secret: ' + (env.STARTER_CRM_DEPLOYED_WEBHOOK_SECRET ? 'given' : 'not given (webhook checks skip)')
    + ', stream hold: ' + env.STARTER_CRM_DEPLOYED_HOLD_SECONDS + ' s');

/** Runs one half and returns its exit code. */
function run(label, command, commandArgs, cwd) {
    console.log('\n== ' + label + ' ==');
    const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit' });
    return result.status === null ? 1 : result.status;
}

const codes = [run('Host checks', process.execPath, ['--test', '--test-reporter=spec', '--test-force-exit', 'tests/deployed/host.test.js'], root)];

if (!args.includes('--no-browser')) {
    const e2e = path.join(root, 'tests', 'e2e');
    codes.push(run('Browser', 'npx', ['playwright', 'test', '--config=deployed.config.js'], e2e));
}

const failed = codes.some((code) => code !== 0);
console.log('\ntest:deployed ' + (failed ? 'FAILED' : 'passed') + ' for ' + env.STARTER_CRM_DEPLOYED_URL);
process.exit(failed ? 1 : 0);
