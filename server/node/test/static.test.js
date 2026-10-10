import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeConfig, startApp } from './helpers.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-static-'));
const files = {
    '.env': 'DROPCOWBOY_API_KEY=never-served',
    'vanilla/index.html': '<!doctype html><!-- vanilla-index -->',
    'shared/dc-api.js': 'export const shared = "shared-module";',
    'shared/lib/format.mjs': 'export const format = "nested-module";',
    'shared/.hidden.js': 'hidden-dotfile'
};

// A raw request, so ../ and backslashes reach the server unnormalised.
function get(url, requestPath) {
    const { port } = new URL(url);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers: { accept: 'text/html' } }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('GET /shared/...', () => {
    let app;
    beforeAll(async () => {
        for (const [name, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
            fs.writeFileSync(path.join(root, name), content);
        }
        app = await startApp(makeConfig({ DC_AUTH_MODE: 'mcp-session', STARTER_CRM_ROOT: root }));
    });
    afterAll(async () => {
        await app.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('serves modules as text/javascript', async () => {
        for (const [requestPath, marker] of [['/shared/dc-api.js', 'shared-module'], ['/shared/lib/format.mjs', 'nested-module']]) {
            const res = await get(app.url, requestPath);
            expect(res.status).toBe(200);
            expect(res.type).toMatch(/^text\/javascript/);
            expect(res.text).toContain(marker);
        }
    });

    it('answers 404 not_found for folders, dotfiles, missing files and escapes, never index.html', async () => {
        const paths = [
            '/shared', '/shared/', '/shared/lib', '/shared/.hidden.js', '/shared/missing.js',
            '/shared/../.env', '/shared/%2e%2e/.env', '/shared/..%2f.env',
            '/shared/..\\.env', '/shared/..%5c.env', '/shared/lib\\format.mjs'
        ];
        for (const requestPath of paths) {
            const res = await get(app.url, requestPath);
            expect(res.status, requestPath).toBe(404);
            expect(JSON.parse(res.text).error.code).toBe('not_found');
        }
    });
});
