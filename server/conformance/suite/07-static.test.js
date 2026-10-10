import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertEnvelope, call, ctx, rawRequest } from '../lib/context.js';

const html = { headers: { accept: 'text/html,application/xhtml+xml' } };

describe('static files, front-ends present (login root)', () => {
    it('serves vanilla/index.html at /', async () => {
        const res = await call('login', '/', html);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);
        assert.match(res.text, /conformance-vanilla-index/);
    });

    it('serves vanilla assets', async () => {
        const res = await call('login', '/app.js');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /javascript/);
        assert.match(res.text, /conformance-vanilla-asset/);
    });

    it('falls back to index.html for client routes on page loads', async () => {
        for (const path of ['/setup', '/contacts/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d']) {
            const res = await call('login', path, html);
            assert.equal(res.status, 200, path);
            assert.match(res.text, /conformance-vanilla-index/);
        }
    });

    it('serves react/dist under /react/, with its own fallback', async () => {
        for (const path of ['/react/', '/react/contacts']) {
            const res = await call('login', path, html);
            assert.equal(res.status, 200, path);
            assert.match(res.text, /conformance-react-index/);
        }
    });

    it('404 not_found for a missing file that is not a page load', async () => {
        assertEnvelope(await call('login', '/missing.js', { headers: { accept: 'application/json' } }), 404, 'not_found');
    });

    it('never serves files outside the front-end folders', async () => {
        for (const path of ['/../.env', '/%2e%2e/.env', '/..%2f.env', '/react/../../.env', '/react/%2e%2e/%2e%2e/.env']) {
            const res = await rawRequest('login', { path, headers: { accept: 'text/html' } });
            assert.ok(!res.text.includes('DROPCOWBOY_'), path + ' served the .env file');
            assert.ok(!res.text.includes(ctx.secrets.webhookSecret), path + ' leaked a secret');
        }
    });
});

describe('static files, shared modules under /shared/', () => {
    it('serves modules as text/javascript, nested ones too', async () => {
        for (const [path, marker] of [['/shared/dc-api.js', /conformance-shared-module/], ['/shared/lib/format.mjs', /conformance-shared-nested/]]) {
            const res = await call('login', path);
            assert.equal(res.status, 200, path);
            assert.match(res.headers.get('content-type'), /^text\/javascript/);
            assert.match(res.text, marker);
        }
    });

    it('is served in every mode', async () => {
        const res = await call('mcp-session', '/shared/dc-api.js');
        assert.equal(res.status, 200);
        assert.match(res.text, /conformance-shared-module/);
    });

    it('404 not_found for folders, never index.html or a listing, even on a page load', async () => {
        for (const path of ['/shared', '/shared/', '/shared/lib', '/shared/lib/']) {
            const res = await rawRequest('login', { path, headers: { accept: 'text/html' } });
            assertEnvelope(res, 404, 'not_found');
            assert.ok(!res.text.includes('conformance-shared-index'), path + ' served shared/index.html');
        }
    });

    it('404 not_found for a missing module, even on a page load, never the front-end index', async () => {
        const res = await call('login', '/shared/missing.js', html);
        assertEnvelope(res, 404, 'not_found');
        assertEnvelope(await call('server', '/shared/dc-api.js', html), 404, 'not_found');
    });

    it('404 not_found for dotfiles', async () => {
        assertEnvelope(await call('login', '/shared/.hidden.js'), 404, 'not_found');
    });

    it('never serves files outside shared/: ../, encoded %2e%2e and %2f, backslashes', async () => {
        const paths = [
            '/shared/../.env', '/shared/../vanilla/app.js',
            '/shared/%2e%2e/.env', '/shared/%2E%2E/vanilla/app.js', '/shared/..%2f.env', '/shared/%2e%2e%2f%2e%2e%2f.env',
            '/shared/..\\.env', '/shared/..\\vanilla\\app.js', '/shared/..%5c.env', '/shared/%2e%2e%5cvanilla%5capp.js',
            '/shared/lib\\format.mjs'
        ];
        for (const path of paths) {
            const res = await rawRequest('login', { path, headers: { accept: 'text/html' } });
            assertEnvelope(res, 404, 'not_found');
            assert.ok(!res.text.includes('DROPCOWBOY_'), path + ' served the .env file');
            assert.ok(!res.text.includes('conformance-vanilla'), path + ' escaped into vanilla/');
        }
    });
});

describe('static files, no front-end yet (server root)', () => {
    it('explains how to start a front-end at /', async () => {
        const res = await call('server', '/', html);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.ok(res.text.length > 20);
    });

    it('explains how to build the React app at /react/', async () => {
        const res = await call('server', '/react/', html);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.match(res.text, /npm/);
    });
});
