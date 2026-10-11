import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devSessionRoute, isLoopbackAddress, isLoopbackHost, readSession } from '../src/dev-session.js';
import { makeConfig } from './helpers.js';

describe('isLoopbackAddress', () => {
    it('accepts IPv4, IPv6 and mapped loopback', () => {
        for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
            expect(isLoopbackAddress(address)).toBe(true);
        }
    });

    it('rejects everything else', () => {
        for (const address of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', '0.0.0.0', 'fe80::1', '', undefined]) {
            expect(isLoopbackAddress(address)).toBe(false);
        }
    });
});

describe('isLoopbackHost', () => {
    it('accepts loopback hostnames with or without a port', () => {
        for (const host of ['localhost', 'localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'LOCALHOST:5173']) {
            expect(isLoopbackHost(host)).toBe(true);
        }
    });

    it('rejects other hostnames, including rebinding tricks', () => {
        for (const host of ['evil.example', 'evil.example:8080', 'localhost.evil.example', '127.0.0.1.nip.io', '', undefined]) {
            expect(isLoopbackHost(host)).toBe(false);
        }
    });
});

describe('the loopback guard', () => {
    async function call(req) {
        const route = devSessionRoute(makeConfig({ DC_AUTH_MODE: 'mcp-session' }));
        return route(req, { set() {}, json() {} }).then(() => null, (err) => err);
    }

    it('ignores X-Forwarded-For and judges the socket address', async () => {
        const err = await call({
            socket: { remoteAddress: '203.0.113.9' },
            headers: { host: 'localhost:8080', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' }
        });
        expect(err.status).toBe(403);
        expect(err.code).toBe('loopback_only');
    });

    it('refuses a loopback peer that sent a foreign Host', async () => {
        const err = await call({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example:8080' } });
        expect(err.code).toBe('loopback_only');
    });
});

describe('readSession', () => {
    let dir;
    let file;
    const now = 1790000000000;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-session-'));
        file = path.join(dir, 'session.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const write = (value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    const codeOf = (promise) => promise.then(() => 'ok', (err) => err.status + ' ' + err.code);

    it('returns a valid session', async () => {
        write({ token: 'tkn', expires_at: now + 60000, site_id: '3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d' });
        expect((await readSession(file, now)).token).toBe('tkn');
    });

    it('maps each failure to its status and code', async () => {
        expect(await codeOf(readSession(file, now))).toBe('404 session_not_found');
        write({ token: 'tkn', expires_at: now });
        expect(await codeOf(readSession(file, now))).toBe('410 session_expired');
        write({ token: 'tkn', expires_at: Math.floor(now / 1000) + 60 });
        expect(await codeOf(readSession(file, now))).toBe('500 session_invalid');
        write({ expires_at: now + 60000 });
        expect(await codeOf(readSession(file, now))).toBe('500 session_invalid');
        write('not json');
        expect(await codeOf(readSession(file, now))).toBe('500 session_invalid');
    });
});
