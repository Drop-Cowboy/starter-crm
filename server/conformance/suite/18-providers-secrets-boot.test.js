import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertEnvelope, call, ctx, deliver, eventBody, mockRequests, postJson, resetMock, sleep } from '../lib/context.js';
import { startIssuer } from '../lib/jwks.js';
import { freePort } from '../lib/process.js';
import { bootFails, bootServer, ext, makeRoot, serverEnv } from '../lib/oneoff.js';
import { secretsSource } from '../lib/providers.js';

const dev = { DC_AUTH_MODE: 'login', DROPCOWBOY_SITE_ID: ctx.siteId };

describe('boot problems for the Phase 2 settings', () => {
    const cases = [
        ['invalid_identity', { DC_AUTH_MODE: 'server', DC_IDENTITY: 'bogus' }],
        ['identity_requires_server_mode', { ...dev, DC_IDENTITY: 'passcode', DC_PASSCODE: 'a-long-enough-passcode' }],
        ['missing_passcode', { ...serverEnvBase(), DC_IDENTITY: 'passcode' }],
        ['weak_passcode', { ...serverEnvBase(), DC_IDENTITY: 'passcode', DC_PASSCODE: 'short-pass' }],
        ['missing_oidc_issuer', { ...serverEnvBase(), DC_IDENTITY: 'oidc', DC_OIDC_AUDIENCE: 'aud' }],
        ['missing_oidc_audience', { ...serverEnvBase(), DC_IDENTITY: 'oidc', DC_OIDC_ISSUER: 'https://issuer.example.com' }],
        ['invalid_oidc_issuer', { ...serverEnvBase(), DC_IDENTITY: 'oidc', DC_OIDC_ISSUER: 'http://issuer.example.com', DC_OIDC_AUDIENCE: 'aud' }],
        ['invalid_oidc_jwks_url', { ...serverEnvBase(), DC_IDENTITY: 'oidc', DC_OIDC_ISSUER: 'https://issuer.example.com', DC_OIDC_AUDIENCE: 'aud', DC_OIDC_JWKS_URL: 'ftp://x.example.com/k' }],
        ['invalid_log_format', { ...dev, DC_LOG_FORMAT: 'xml' }],
        ['invalid_log_requests', { ...dev, DC_LOG_REQUESTS: 'maybe' }],
        ['invalid_csp', { ...dev, DC_CSP: 'sometimes' }],
        ['invalid_cors_origins', { ...dev, DC_CORS_ORIGINS: '*' }],
        ['invalid_cors_origins', { ...dev, DC_CORS_ORIGINS: 'https://ok.example.com/path' }],
        ['invalid_rate_limit', { ...dev, DC_RATE_LIMIT: 'distributed' }],
        ['missing_redis_url', { ...dev, DC_RATE_LIMIT: 'redis' }],
        ['invalid_token_cache', { ...dev, DC_TOKEN_CACHE: 'maybe' }],
        ['invalid_secrets_provider', { ...dev, DC_SECRETS: 'nonexistent' }],
        ['missing_secrets_dir', { ...dev, DC_SECRETS: 'file' }],
        ['invalid_provider', { ...dev, DC_LOG: './does-not-exist.' + ext }]
    ];
    for (const [code, env] of cases) {
        it(code + ': ' + JSON.stringify(Object.entries(env).filter(([k]) => /^DC_(?!AUTH)/.test(k)).map(([k, v]) => k + '=' + v)), async () => {
            const output = await bootFails(env);
            assert.match(output, new RegExp(code), 'output should name ' + code + ':\n' + output);
            assert.ok(!output.includes('short-pass') && !output.includes('a-long-enough-passcode'), 'the passcode must not be printed');
        });
    }

    it('a provider file with the wrong shape is invalid_provider', async () => {
        const root = makeRoot({ ['bad.' + ext]: ext === 'py' ? 'name = "bad"\n' : 'export const name = "bad";\n' });
        const output = await bootFails({ ...dev, DC_LOG: './bad.' + ext }, root);
        assert.match(output, /invalid_provider/);
    });

    it('a provider\'s own validate() problems are reported', async () => {
        const source = ext === 'py'
            ? 'name = "v"\nconfig_keys = []\ndef validate(env):\n    return [{"code": "custom_problem", "message": "nope", "fix": "do the thing"}]\ndef create(ctx):\n    return object()\n'
            : 'export const name = "v"; export const configKeys = []; export const validate = () => [{ code: "custom_problem", message: "nope", fix: "do the thing" }]; export const create = () => ({});\n';
        const root = makeRoot({ ['v.' + ext]: source });
        const output = await bootFails({ ...dev, DC_LOG: './v.' + ext }, root);
        assert.match(output, /custom_problem/);
    });

    it('production with the dev identity still names production_dev_identity', async () => {
        const output = await bootFails({ ...serverEnvBase(), DC_ENV: 'production', STARTER_CRM_USER_ID: ctx.userId });
        assert.match(output, /production_dev_identity/);
    });
});

function serverEnvBase() {
    return {
        DC_AUTH_MODE: 'server',
        DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
        DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
        DROPCOWBOY_SITE_ID: ctx.siteId,
        STARTER_CRM_USER_ID: ctx.userId
    };
}

describe('settings that need their own server', () => {
    it('DC_CSP=off sends no CSP header, and DC_LOG_FORMAT=json writes JSON lines with the request id', async () => {
        const server = await bootServer('csp-off', { ...serverEnv(), DC_CSP: 'off', DC_LOG_FORMAT: 'json', DC_LOG_REQUESTS: 'on' });
        try {
            const id = 'json-' + crypto.randomUUID();
            const res = await call('csp-off', '/healthz', { headers: { 'x-request-id': id } });
            assert.equal(res.headers.get('content-security-policy'), null);
            assert.equal(res.headers.get('content-security-policy-report-only'), null);
            await sleep(200);
            const lines = server.output().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
            const access = lines.find((l) => l.request_id === id);
            assert.ok(access, 'a JSON access line:\n' + server.output());
            assert.equal(access.method, 'GET');
            assert.equal(access.path, '/healthz');
            assert.equal(access.status, 200);
            assert.equal(typeof access.duration_ms, 'number');
        } finally {
            await server.stop();
        }
    });

    it('DC_LOG_FORMAT defaults to json in production and to pretty in development', async () => {
        const dev = await bootServer('log-dev', { ...serverEnv(), DC_LOG_REQUESTS: 'on' });
        const prod = await bootServer('log-prod', { ...serverEnv(), DC_ENV: 'production', DC_IDENTITY: 'passcode', DC_PASSCODE: 'a-long-enough-passcode', STARTER_CRM_USER_ID: ctx.userId });
        try {
            await call('log-dev', '/healthz');
            await call('log-prod', '/healthz');
            await sleep(200);
            assert.ok(!dev.output().split('\n').some((line) => line.startsWith('{')), 'development is not JSON:\n' + dev.output());
            const lines = prod.output().split('\n').filter((line) => line.startsWith('{'));
            assert.ok(lines.length > 0 && lines.every((line) => JSON.parse(line).time), 'production is JSON:\n' + prod.output());
            assert.ok(lines.some((line) => JSON.parse(line).path === '/healthz'), 'production logs requests by default');
        } finally {
            await dev.stop();
            await prod.stop();
        }
    });

    it('DC_OIDC_JWKS_URL skips discovery', async () => {
        const issuer = await startIssuer(await freePort(), ctx.oidc.audience);
        const env = { ...serverEnv(), DC_IDENTITY: 'oidc', DC_OIDC_ISSUER: issuer.issuer, DC_OIDC_AUDIENCE: ctx.oidc.audience, DC_OIDC_JWKS_URL: issuer.issuer + '/jwks.json' };
        delete env.STARTER_CRM_USER_ID;
        const server = await bootServer('oidc-jwks', env);
        try {
            const res = await postJson('oidc-jwks', '/api/dropcowboy/token', { purpose: 'session' }, { authorization: 'Bearer ' + issuer.token() });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(issuer.fetches.discovery, 0, 'discovery was not needed');
            assert.ok(issuer.fetches.jwks >= 1);
        } finally {
            await server.stop();
            await issuer.close();
        }
    });
});

describe('secrets providers', () => {
    it('file: reads one file per secret, and warns about a world-readable one without printing it', async () => {
        const dir = fs.mkdtempSync(path.join(makeRoot(), 'secrets-'));
        const files = {
            DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
            DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
            DROPCOWBOY_WEBHOOK_SECRET: ctx.secrets.webhookSecret
        };
        for (const [name, value] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, name), value + '\n', { mode: name === 'DROPCOWBOY_API_SECRET' ? 0o644 : 0o600 });
            if (name === 'DROPCOWBOY_API_SECRET') fs.chmodSync(path.join(dir, name), 0o644);
        }
        const env = { ...serverEnv(), DC_SECRETS: 'file', DC_SECRETS_DIR: dir };
        delete env.DROPCOWBOY_API_KEY;
        delete env.DROPCOWBOY_API_SECRET;
        delete env.DROPCOWBOY_WEBHOOK_SECRET;
        await resetMock();
        const server = await bootServer('secrets-file', env);
        try {
            const res = await postJson('secrets-file', '/api/dropcowboy/token', { purpose: 'session' });
            assert.equal(res.status, 200, 'the API key came from a file: ' + JSON.stringify(res.body));
            const [upstream] = await mockRequests();
            assert.equal(upstream.headers['x-key'], ctx.secrets.apiKey);
            assert.equal((await deliver('secrets-file', eventBody(crypto.randomUUID()))).status, 200, 'the webhook secret came from a file');
            const output = server.output();
            assert.match(output, /world-readable/i);
            assert.match(output, /DROPCOWBOY_API_SECRET/);
            for (const secret of [ctx.secrets.apiKey, ctx.secrets.apiSecret, ctx.secrets.webhookSecret]) {
                assert.ok(!output.includes(secret), 'a secret was printed');
            }
        } finally {
            await server.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('file: a required secret that is missing is a boot problem naming the variable', async () => {
        const dir = makeRoot();
        const env = { ...serverEnv(), DC_SECRETS: 'file', DC_SECRETS_DIR: dir };
        delete env.DROPCOWBOY_API_KEY;
        delete env.DROPCOWBOY_API_SECRET;
        const output = await bootFails(env);
        assert.match(output, /DROPCOWBOY_API_KEY/);
    });

    it('a custom provider is loaded before configuration and refreshed on the interval, keeping the last good values on failure', async () => {
        const root = makeRoot();
        const file = path.join(root, 'live-secrets.json');
        const write = (webhook) => fs.writeFileSync(file, JSON.stringify({
            DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
            DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
            DROPCOWBOY_WEBHOOK_SECRET: webhook
        }));
        const first = 'rotating-one-' + crypto.randomUUID();
        const second = 'rotating-two-' + crypto.randomUUID();
        write(first);
        fs.writeFileSync(path.join(root, 'secrets.' + ext), secretsSource(ctx.serverLang, file));
        const env = { ...serverEnv(), DC_SECRETS: './secrets.' + ext, DC_SECRETS_REFRESH_SECONDS: '1' };
        delete env.DROPCOWBOY_API_KEY;
        delete env.DROPCOWBOY_API_SECRET;
        delete env.DROPCOWBOY_WEBHOOK_SECRET;
        const server = await bootServer('secrets-live', env, root);
        const delivery = (secret) => deliver('secrets-live', eventBody(crypto.randomUUID()), { secret });
        try {
            assert.equal((await delivery(first)).status, 200);
            assertEnvelope(await delivery(second), 401, 'invalid_signature');

            write(second);
            await sleep(2600);
            assert.equal((await delivery(second)).status, 200, 'the new value is in use without a restart');
            assertEnvelope(await delivery(first), 401, 'invalid_signature');

            fs.writeFileSync(file, '{ not json');
            await sleep(2600);
            assert.equal((await delivery(second)).status, 200, 'a failed refresh keeps the last good value');
            // A server in a container reaches this process through docker's output
            // relay, a few milliseconds behind the response, so give the line time.
            for (let i = 0; i < 20 && !/refresh/i.test(server.output()); i++) await sleep(100);
            const output = server.output();
            assert.match(output, /refresh/i, 'the failure is logged');
            for (const secret of [first, second, ctx.secrets.apiKey, ctx.secrets.apiSecret]) {
                assert.ok(!output.includes(secret), 'refreshed secrets must never be logged');
            }
        } finally {
            await server.stop();
        }
    });
});
