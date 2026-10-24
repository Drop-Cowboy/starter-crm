import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { assertEnvelope, call, ctx, rawBytes, rawRequest } from '../lib/context.js';

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

describe('static files, caching and compression', () => {
    it('lets a content-hashed build asset be cached for a year, immutable', async () => {
        const res = await rawBytes('login', { path: '/react/assets/index-Ab3dEf90.js' });
        assert.equal(res.status, 200);
        assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    });

    it('never makes a page, an unhashed file or a shared module immutable: they revalidate', async () => {
        for (const path of ['/', '/react/', '/react/assets/logo.js', '/app.js', '/shared/dc-api.js']) {
            const res = await rawBytes('login', { path, headers: { accept: 'text/html' } });
            assert.equal(res.status, 200, path);
            assert.equal(res.headers['cache-control'], 'no-cache', path);
        }
    });

    it('answers a matching If-None-Match with 304 and no body', async () => {
        const first = await rawBytes('login', { path: '/app.js' });
        assert.ok(first.headers.etag, 'a file needs an ETag');
        const second = await rawBytes('login', { path: '/app.js', headers: { 'if-none-match': first.headers.etag } });
        assert.equal(second.status, 304);
        assert.equal(second.bytes.length, 0);
    });

    it('gzips text of 1 KB or more when the browser accepts it, with Vary', async () => {
        for (const path of ['/big.js', '/react/assets/index-Ab3dEf90.js']) {
            const plain = await rawBytes('login', { path });
            const packed = await rawBytes('login', { path, headers: { 'accept-encoding': 'gzip, deflate, br' } });
            assert.equal(packed.status, 200, path);
            assert.equal(packed.headers['content-encoding'], 'gzip', path);
            assert.match(packed.headers.vary, /Accept-Encoding/i, path);
            assert.equal(String(packed.bytes.length), packed.headers['content-length'], path);
            assert.ok(packed.bytes.length < plain.bytes.length, path + ' did not get smaller');
            assert.equal(zlib.gunzipSync(packed.bytes).toString(), plain.bytes.toString(), path);
            assert.equal(plain.headers['content-encoding'], undefined, path + ' was compressed without being asked');
            assert.match(plain.headers.vary, /Accept-Encoding/i, path + ' must Vary even when sent plain');
        }
    });

    it('does not gzip when the browser refuses it with q=0, or for a file under 1 KB', async () => {
        const refused = await rawBytes('login', { path: '/big.js', headers: { 'accept-encoding': 'gzip;q=0' } });
        assert.equal(refused.headers['content-encoding'], undefined);
        const small = await rawBytes('login', { path: '/app.js', headers: { 'accept-encoding': 'gzip' } });
        assert.equal(small.headers['content-encoding'], undefined);
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
