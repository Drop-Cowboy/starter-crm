// The Netlify variant's own code: the Async Workloads job, the CDN's headers and the functions' routing. The core it
// wraps is tested in server/node and by the conformance suite, which runs against scripts/serve.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ErrorDoNotRetry, ErrorRetryAfterDelay } from '@netlify/async-workloads';
import { loadConfig } from '../../node/src/config.js';
import { backoffMs } from '../../node/src/processor.js';
import { applySecurityHeaders } from '../../node/src/security.js';
import { headersFile } from '../lib/cdn-headers.js';
import { runJob } from '../lib/webhook-job.js';
import { config as apiConfig } from '../functions/api.mjs';
import { config as maintenanceConfig } from '../functions/maintenance.mjs';
import { asyncWorkloadConfig } from '../functions/webhook-jobs.mjs';
import { EVENT } from '../../node/src/providers/webhooks/netlify-async.js';

const EVENT_ID = '3f0c7c1e-6a51-4d2b-9a7e-2d8b1c4e5f60';

function booted(consume) {
    return { ok: true, core: { runtime: { dispatcher: { consume } } }, config: { events: { webhooks: 'netlify-async' } } };
}

function block(text, path) {
    const blocks = text.trim().split('\n\n');
    return blocks.find((lines) => lines.split('\n')[0] === path);
}

describe('the Async Workloads job', () => {
    it('finishes an event the core processed', async () => {
        const calls = [];
        await runJob({ eventData: { event_id: EVENT_ID }, attempt: 0 }, booted(async (data, attempt) => {
            calls.push([data, attempt]);
            return { outcome: 'processed' };
        }), backoffMs);
        assert.deepEqual(calls, [[{ event_id: EVENT_ID }, 0]]);
    });

    it('finishes an event the core skipped or found missing, without a retry', async () => {
        for (const outcome of ['skipped', 'missing', 'failed', 'ignored']) {
            await runJob({ eventData: {}, attempt: 3 }, booted(async () => ({ outcome })), backoffMs);
        }
    });

    it('waits exactly the processor backoff before the next attempt', async () => {
        const job = runJob({ eventData: { event_id: EVENT_ID }, attempt: 2 },
            booted(async () => ({ outcome: 'retry', error: 'the handler failed', retryAfterMs: 8000 })), backoffMs);
        await assert.rejects(job, (err) => {
            assert.ok(err instanceof ErrorRetryAfterDelay);
            assert.equal(err.message, 'the handler failed');
            assert.equal(err.retryDelay, 8000);
            assert.equal(err.forceDelayTime, true);
            return true;
        });
    });

    it('retries an event when the server cannot boot, with backoff', async () => {
        await assert.rejects(runJob({ eventData: {}, attempt: 1 }, { ok: false }, backoffMs), (err) => {
            assert.ok(err instanceof ErrorRetryAfterDelay);
            assert.equal(err.retryDelay, backoffMs(2));
            assert.doesNotMatch(err.message, /AWL_API_KEY|DROPCOWBOY/);
            return true;
        });
    });

    it('drops an event that reaches a deploy using another webhook mode', async () => {
        const other = { ok: true, core: { runtime: { dispatcher: {} } }, config: { events: { webhooks: 'qstash' } } };
        await assert.rejects(runJob({ eventData: {}, attempt: 0 }, other, backoffMs), (err) => {
            assert.ok(err instanceof ErrorDoNotRetry);
            assert.match(err.message, /qstash/);
            return true;
        });
    });
});

describe('the CDN headers', () => {
    const env = { NETLIFY: 'true', NETLIFY_DB_URL: 'postgres://u:p@db-pooler.example.test/crm?sslmode=require' };
    const { config } = loadConfig(env);

    it('sets the core security headers on every file', () => {
        const expected = new Response(null);
        applySecurityHeaders(expected, config);
        const all = block(headersFile(config, []), '/*').split('\n').slice(1);
        assert.deepEqual(all, [...expected.headers].map(([name, value]) => '  ' + name + ': ' + value));
        assert.ok(all.some((line) => line.startsWith('  strict-transport-security: ')), 'production sets HSTS');
        assert.ok(all.some((line) => /content-security-policy/.test(line)));
    });

    it('caches like the core: a year for hashed React assets, revalidate for everything else', () => {
        const text = headersFile(config, [
            '/index.html', '/app.js', '/shared/server-api.js', '/react/index.html',
            '/react/assets/index-BnisLzLV.js', '/react/assets/index-BBWtMXgW.css', '/react/assets/logo.svg',
            '/assets/vendor-AbCdEfGh12.js', '/_headers'
        ]);
        assert.doesNotMatch(block(text, '/*'), /cache-control/, 'Netlify would join it with each file\'s value');
        assert.equal(block(text, '/react/assets/index-BnisLzLV.js'), '/react/assets/index-BnisLzLV.js\n  cache-control: public, max-age=31536000, immutable');
        assert.match(block(text, '/react/assets/index-BBWtMXgW.css'), /immutable/);
        for (const url of ['/', '/index.html', '/app.js', '/shared/server-api.js', '/react/', '/react/index.html', '/react/assets/logo.svg']) {
            assert.equal(block(text, url), url + '\n  cache-control: no-cache');
        }
        assert.equal(block(text, '/assets/vendor-AbCdEfGh12.js'), '/assets/vendor-AbCdEfGh12.js\n  cache-control: no-cache', 'only the React build is hashed');
        assert.equal(block(text, '/_headers'), undefined);
    });

    it('follows the sign-in mode, so the CSP allows the Auth0 tenant', () => {
        const login = loadConfig({ ...env, DC_AUTH_MODE: 'login', AUTH0_DOMAIN: 'tenant.example.test', AUTH0_CLIENT_ID: 'client' }).config;
        assert.match(block(headersFile(login, []), '/*'), /https:\/\/tenant\.example\.test/);
    });
});

describe('the functions', () => {
    it('sends every path the CDN has no file for to the core', () => {
        assert.deepEqual(apiConfig, { path: '/*', preferStatic: true });
    });

    it('takes the event the netlify-async provider sends', () => {
        assert.deepEqual(asyncWorkloadConfig.events, [EVENT]);
        assert.ok(asyncWorkloadConfig.maxRetries >= 50, 'above DC_WEBHOOK_MAX_ATTEMPTS, so the processor decides');
    });

    it('runs maintenance on a schedule, not on a path', () => {
        assert.equal(typeof maintenanceConfig.schedule, 'string');
        assert.equal(maintenanceConfig.path, undefined);
    });

    it('installs Async Workloads at the root too, where the extension puts its router', () => {
        const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
        const pinned = read('../package.json').dependencies['@netlify/async-workloads'];
        assert.equal(read('../../../package.json').dependencies['@netlify/async-workloads'], pinned);
        assert.equal(read('../../../package-lock.json').packages['node_modules/@netlify/async-workloads'].version, pinned);
        assert.deepEqual(read('../../../package.json').overrides, read('../package.json').overrides);
        const stub = (file, dir) => fileURLToPath(new URL(read(file).dependencies['@netlify/sdk'].replace(/^file:/, dir), import.meta.url));
        assert.equal(stub('../../../package.json', '../../../'), stub('../package.json', '../'));
        const toml = fs.readFileSync(new URL('../../../netlify.toml', import.meta.url), 'utf8');
        assert.match(toml, /command = "npm ci --omit=dev && /);
        assert.match(toml, /npm ci --omit=dev --prefix server\/netlify/);
    });

    it('installs the empty stand-in for @netlify/sdk, and one copy of Async Workloads, in both lockfiles', () => {
        const stub = JSON.parse(fs.readFileSync(new URL('../unused-netlify-sdk/package.json', import.meta.url), 'utf8'));
        assert.equal(stub.name, '@netlify/sdk');
        assert.equal(stub.main, undefined);
        assert.deepEqual(fs.readdirSync(new URL('../unused-netlify-sdk/', import.meta.url)), ['package.json']);
        for (const file of ['../../../package-lock.json', '../package-lock.json']) {
            const lock = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8')).packages;
            const where = (name) => Object.keys(lock).filter((key) => key.endsWith('node_modules/' + name));
            assert.deepEqual(where('@netlify/sdk'), ['node_modules/@netlify/sdk'], file);
            assert.equal(lock['node_modules/@netlify/sdk'].link, true, file + ' installs the real @netlify/sdk');
            assert.equal(lock[lock['node_modules/@netlify/sdk'].resolved].name, '@netlify/sdk', file);
            assert.deepEqual(where('@netlify/async-workloads'), ['node_modules/@netlify/async-workloads'], file);
        }
    });

    it('uses an Async Workloads that imports nothing outside what it is left with', () => {
        const kept = new Set(['@netlify/blobs', '@lukeed/ms', 'commander']);
        const root = fileURLToPath(new URL('../node_modules/@netlify/async-workloads/', import.meta.url));
        const imports = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"'.][^"']*)["']/gm;
        const unexpected = [];
        for (const file of fs.readdirSync(root, { recursive: true })) {
            if (file.split(path.sep).includes('node_modules') || !/\.[cm]?js$/.test(file)) continue;
            for (const [, specifier] of fs.readFileSync(path.join(root, file), 'utf8').matchAll(imports)) {
                const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
                if (!kept.has(name) && !isBuiltin(specifier)) unexpected.push(file + ': ' + specifier);
            }
        }
        assert.deepEqual(unexpected, [], 'the package imports something the @netlify/sdk stand-in or the override removed');
    });
});
