import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { assertEnvelope, call, ctx, rawRequest } from '../lib/context.js';

const sessionFile = path.join(ctx.servers['mcp-session'].root, '.dropcowboy', 'session.json');
const SITE_ID = 'c4d5e6f7-8a9b-4c0d-9e1f-2a3b4c5d6e7f';
const TOKEN = 'conformance-session-token';

function writeSession(value) {
    fs.writeFileSync(sessionFile, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('GET /__dev/session', () => {
    afterEach(() => fs.rmSync(sessionFile, { force: true }));

    it('404 session_not_found when the file is missing', async () => {
        const res = await call('mcp-session', '/__dev/session');
        assertEnvelope(res, 404, 'session_not_found');
        assert.match(res.body.error.message, /session\.json/);
    });

    it('returns the agent-minted session', async () => {
        const expiresAt = Date.now() + 600000;
        writeSession({ token: TOKEN, expires_at: expiresAt, site_id: SITE_ID });
        const res = await call('mcp-session', '/__dev/session');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(res.body, { token: TOKEN, expires_at: expiresAt, site_id: SITE_ID });
    });

    it('re-reads the file on every request', async () => {
        writeSession({ token: 'first', expires_at: Date.now() + 600000 });
        assert.equal((await call('mcp-session', '/__dev/session')).body.token, 'first');
        writeSession({ token: 'second', expires_at: Date.now() + 600000 });
        assert.equal((await call('mcp-session', '/__dev/session')).body.token, 'second');
    });

    it('site_id falls back to DROPCOWBOY_SITE_ID, here unset, so null', async () => {
        writeSession({ token: TOKEN, expires_at: Date.now() + 600000 });
        assert.equal((await call('mcp-session', '/__dev/session')).body.site_id, null);
    });

    it('410 session_expired when expires_at has passed', async () => {
        writeSession({ token: TOKEN, expires_at: Date.now() - 1000, site_id: SITE_ID });
        assertEnvelope(await call('mcp-session', '/__dev/session'), 410, 'session_expired');
    });

    const invalid = [
        ['not JSON', 'not json at all'],
        ['a JSON array', '[]'],
        ['no token', { expires_at: Date.now() + 600000 }],
        ['an empty token', { token: '', expires_at: Date.now() + 600000 }],
        ['expires_at in seconds', { token: TOKEN, expires_at: Math.floor(Date.now() / 1000) + 600 }],
        ['expires_at as a string', { token: TOKEN, expires_at: new Date(Date.now() + 600000).toISOString() }]
    ];
    for (const [label, content] of invalid) {
        it('500 session_invalid for ' + label, async () => {
            writeSession(content);
            assertEnvelope(await call('mcp-session', '/__dev/session'), 500, 'session_invalid');
        });
    }

    it('403 loopback_only when Host is not a loopback name (DNS rebinding)', async () => {
        writeSession({ token: TOKEN, expires_at: Date.now() + 600000 });
        for (const host of ['evil.example', 'evil.example:8080', 'localhost.evil.example']) {
            const res = await rawRequest('mcp-session', { path: '/__dev/session', headers: { host } });
            assert.equal(res.status, 403, 'Host ' + host);
            assert.equal(res.body.error.code, 'loopback_only');
            assert.ok(!res.text.includes(TOKEN));
        }
    });

    it('accepts localhost and 127.0.0.1 Host headers', async () => {
        writeSession({ token: TOKEN, expires_at: Date.now() + 600000 });
        const port = new URL(ctx.servers['mcp-session'].url).port;
        for (const host of ['localhost:' + port, '127.0.0.1:' + port, 'localhost']) {
            const res = await rawRequest('mcp-session', { path: '/__dev/session', headers: { host } });
            assert.equal(res.status, 200, 'Host ' + host);
        }
    });

    it('judges the peer by its socket, not by forwarding headers', async () => {
        // The peer here is loopback; spoofed headers claiming otherwise must
        // not matter. (The reverse, a remote peer claiming loopback, needs a
        // second machine and is covered by each server's unit tests.)
        writeSession({ token: TOKEN, expires_at: Date.now() + 600000 });
        const res = await call('mcp-session', '/__dev/session', {
            headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', forwarded: 'for=203.0.113.9' }
        });
        assert.equal(res.status, 200);
    });
});
