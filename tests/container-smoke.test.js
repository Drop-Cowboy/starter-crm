// What the conformance suite cannot see about a container image: who it runs as,
// whether Docker considers it healthy, how it behaves with the safest run
// options, and that it stops cleanly. The conformance suite (see
// scripts/lib/container-server.sh) already proves the HTTP behaviour.
//
//   IMAGE=starter-crm:test node --test tests/container-smoke.test.js
//
// Where it sits: `npm test` runs it once per image after building them
// (stages container:node and container:python in tests/run-all.mjs).
// It needs Docker and nothing else, and no settings or secrets of yours: every
// value below is made up for the run.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const image = process.env.IMAGE;
if (!image) throw new Error('Set IMAGE to the image to check, for example IMAGE=starter-crm:test');

const started = [];
after(() => {
    for (const name of started) docker(['rm', '--force', name]);
});

describe('container image ' + image, () => {
    it('declares a numeric, non-root user and a health check on /healthz', () => {
        const config = JSON.parse(docker(['image', 'inspect', image]).stdout)[0].Config;
        assert.match(config.User, /^[1-9][0-9]*(:[1-9][0-9]*)?$/, 'USER must be a numeric id other than 0, got "' + config.User + '"');
        assert.ok(config.Healthcheck, 'the image has no HEALTHCHECK');
        assert.match(config.Healthcheck.Test.join(' '), /healthz/);
        assert.ok(config.Env.includes('DC_ENV=production'), 'DC_ENV must default to production');
        assert.ok(config.ExposedPorts && config.ExposedPorts['8080/tcp'], 'port 8080 must be exposed');
    });

    it('becomes healthy under the strictest run options and answers on the published port', async () => {
        const name = run([
            // The strictest options a host is likely to apply.
            '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--health-interval', '1s', '--health-start-period', '1s',
            '-p', '127.0.0.1::8080',
            ...validEnv()
        ]);
        await waitFor(() => inspect(name, '{{.State.Health.Status}}') === 'healthy', 'Docker to report the container healthy', name);

        const uid = docker(['exec', name, 'id', '-u']).stdout.trim();
        assert.notEqual(uid, '0', 'the server must not run as root');

        // Reached through the published port, so the server is bound to 0.0.0.0.
        const port = docker(['port', name, '8080/tcp']).stdout.trim().split('\n')[0].split(':').pop();
        const res = await fetch('http://127.0.0.1:' + port + '/healthz');
        assert.equal(res.status, 200);
        const config = await (await fetch('http://127.0.0.1:' + port + '/api/config')).json();
        assert.equal(config.auth_mode, 'server');

        // Writes nothing to its own filesystem, so it runs on a read-only one.
        const wrote = docker(['diff', name]).stdout.trim();
        assert.equal(wrote, '', 'the server wrote to the container filesystem:\n' + wrote);
    });

    it('stops on SIGTERM within the grace period and exits 0', async () => {
        const name = run([
            '--health-interval', '1s', '--health-start-period', '1s',
            ...validEnv()
        ]);
        await waitFor(() => inspect(name, '{{.State.Health.Status}}') === 'healthy', 'Docker to report the container healthy', name);
        const begun = Date.now();
        // The default 10 s stop timeout: past it Docker sends SIGKILL, which exits 137.
        docker(['stop', '--time', '10', name]);
        const seconds = (Date.now() - begun) / 1000;
        assert.equal(inspect(name, '{{.State.ExitCode}}'), '0', 'exit code after SIGTERM (137 means it was killed)');
        assert.ok(seconds < 9, 'took ' + seconds + ' s to stop');
    });

    it('refuses the local-only dev identity by default, because DC_ENV is production', () => {
        const result = docker(['run', '--rm', ...env({ DC_AUTH_MODE: 'server', DROPCOWBOY_API_KEY: 'smoke-key', DROPCOWBOY_API_SECRET: 'smoke-secret', DROPCOWBOY_SITE_ID: crypto.randomUUID(), STARTER_CRM_USER_ID: crypto.randomUUID() }), image], { allowFailure: true });
        assert.notEqual(result.status, 0, 'the container started with the dev identity in production');
        assert.match(result.stdout + result.stderr, /production_dev_identity/);
    });

    it('has no .env, no tests and no Building Blocks in /app', () => {
        const listing = docker(['run', '--rm', '--entrypoint', 'find', image, '/app', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/site-packages/*']).stdout;
        const forbidden = listing.split('\n').filter((file) => /(^|\/)\.env(\..+)?$|\.test\.jsx?$|\/tests?\/|building-blocks|\.cdn-cache|\/\.git(\/|$)/i.test(file));
        assert.deepEqual(forbidden, []);
    });
});

// ---- Helpers ---------------------------------------------------------------

/** The settings every container here gets: made-up, and with no host-specific values. */
function env(values) {
    const out = [];
    for (const [name, value] of Object.entries(values)) out.push('--env', name + '=' + value);
    return out;
}

/** A production-safe configuration: server mode behind the passcode identity. The key and secret are never used. */
function validEnv() {
    return env({
        DC_AUTH_MODE: 'server',
        DC_IDENTITY: 'passcode',
        DC_PASSCODE: 'smoke-' + crypto.randomUUID(),
        DROPCOWBOY_API_KEY: 'smoke-key-' + crypto.randomUUID(),
        DROPCOWBOY_API_SECRET: 'smoke-secret-' + crypto.randomUUID(),
        DROPCOWBOY_SITE_ID: crypto.randomUUID()
    });
}

/** Starts a detached container and returns its name; it is removed after the run. */
function run(options) {
    const name = 'starter-crm-smoke-' + crypto.randomUUID();
    started.push(name);
    docker(['run', '--detach', '--name', name, ...options, image]);
    return name;
}

function inspect(name, format) {
    return docker(['inspect', '--format', format, name]).stdout.trim();
}

async function waitFor(check, what, name, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        if (inspect(name, '{{.State.Running}}') !== 'true') {
            assert.fail('the container stopped while waiting for ' + what + ':\n' + docker(['logs', name]).stdout + docker(['logs', name]).stderr);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.fail('timed out waiting for ' + what + ':\n' + docker(['logs', name]).stdout + docker(['logs', name]).stderr);
}

function docker(args, { allowFailure = false } = {}) {
    const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure && args[0] !== 'rm') {
        throw new Error('docker ' + args.join(' ') + ' failed (' + result.status + '):\n' + result.stdout + result.stderr);
    }
    return result;
}
