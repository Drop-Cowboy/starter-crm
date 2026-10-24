import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { assertEnvelope, call, client, ctx, mockRequests, postJson, resetMock, setCookies, uuidv5 } from '../lib/context.js';

const MODE = 'passcode';
const ORIGIN = 'https://crm.example.com';
const COOKIE = '__Host-starter_crm_session';
const OWNER = () => uuidv5(ctx.siteId, 'passcode|owner');

const b64 = (value) => Buffer.from(value).toString('base64url');

// The documented cookie format, rebuilt here so the suite can forge valid,
// expired and tampered cookies without help from the server.
function forgeCookie({ sub = OWNER(), iat, exp, passcode = ctx.secrets.passcode, siteId = ctx.siteId } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = b64(JSON.stringify({ v: 1, sub, iat: iat ?? now, exp: exp ?? now + 3600 }));
    const key = crypto.createHash('sha256').update('starter-crm-session|' + siteId + '|' + passcode).digest();
    const mac = crypto.createHmac('sha256', key).update(payload).digest('base64url');
    return payload + '.' + mac;
}

const signIn = (passcode = ctx.secrets.passcode, headers = {}) =>
    postJson(MODE, '/api/auth/passcode', { passcode }, { origin: ORIGIN, ...client(), ...headers });

const cookieHeader = (value) => ({ cookie: COOKIE + '=' + value });

describe('passcode identity', () => {
    beforeEach(resetMock);

    it('is signed out without a cookie, and protected routes answer 401 unauthenticated', async () => {
        const session = await call(MODE, '/api/auth/session');
        assert.deepEqual(session.body, { identity: 'passcode', signed_in: false, user: null });
        assertEnvelope(await postJson(MODE, '/api/dropcowboy/token', { purpose: 'session' }, { origin: ORIGIN, ...client() }), 401, 'unauthenticated');
        assertEnvelope(await call(MODE, '/api/dropcowboy/readiness'), 401, 'unauthenticated');
        assertEnvelope(await call(MODE, '/api/events'), 401, 'unauthenticated');
        assert.deepEqual(await mockRequests(), []);
    });

    it('signing in sets a hardened session cookie', async () => {
        const res = await signIn();
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { signed_in: true });
        const [cookie, ...others] = setCookies(res);
        assert.equal(others.length, 0, 'exactly one cookie');
        assert.match(cookie, new RegExp('^' + COOKIE + '=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;'));
        assert.match(cookie, /;\s*HttpOnly/i);
        assert.match(cookie, /;\s*SameSite=Lax/i);
        assert.match(cookie, /;\s*Path=\//i);
        assert.match(cookie, /;\s*Max-Age=43200/i);
        assert.match(cookie, /;\s*Secure/i, 'production cookies are Secure');
        assert.ok(!/;\s*Domain=/i.test(cookie), '__Host- cookies must not set Domain');
        assert.ok(!cookie.includes(ctx.secrets.passcode), 'the passcode must not be in the cookie');
    });

    it('the session cookie is the documented signed format for the owner id', async () => {
        const res = await signIn();
        const value = setCookies(res)[0].split(';')[0].slice(COOKIE.length + 1);
        const [payload, mac] = value.split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        assert.equal(claims.v, 1);
        assert.equal(claims.sub, OWNER());
        assert.equal(claims.exp - claims.iat, 43200);
        assert.equal(mac, forgeCookie({ sub: claims.sub, iat: claims.iat, exp: claims.exp }).split('.')[1]);
    });

    it('a signed-in session reports the user and can mint for them', async () => {
        const value = setCookies(await signIn())[0].split(';')[0].slice(COOKIE.length + 1);
        const headers = { ...cookieHeader(value), ...client() };
        const session = await call(MODE, '/api/auth/session', { headers });
        assert.deepEqual(session.body, { identity: 'passcode', signed_in: true, user: { id: OWNER() } });

        const token = await postJson(MODE, '/api/dropcowboy/token', { purpose: 'phone' }, { ...headers, origin: ORIGIN });
        assert.equal(token.status, 200);
        const [upstream] = await mockRequests();
        assert.equal(upstream.body.sub, OWNER());
    });

    it('a wrong, empty or missing passcode is 401 invalid_passcode with no cookie', async () => {
        for (const body of [{ passcode: 'wrong-passcode-value' }, { passcode: '' }, {}, { passcode: 12345 }]) {
            const res = await postJson(MODE, '/api/auth/passcode', body, { origin: ORIGIN, ...client() });
            assertEnvelope(res, 401, 'invalid_passcode');
            assert.deepEqual(setCookies(res), []);
        }
    });

    it('sign-in must be JSON', async () => {
        const res = await call(MODE, '/api/auth/passcode', {
            method: 'POST',
            headers: { 'content-type': 'text/plain', origin: ORIGIN, ...client() },
            body: JSON.stringify({ passcode: ctx.secrets.passcode })
        });
        assertEnvelope(res, 415, 'unsupported_media_type');
    });

    it('CSRF: only a trusted Origin, or Sec-Fetch-Site same-origin without one, may sign in', async () => {
        const cases = [
            [{ origin: 'https://evil.example.net' }, 403],
            [{ origin: 'null' }, 403],
            [{}, 403],
            [{ 'sec-fetch-site': 'cross-site' }, 403],
            [{ 'sec-fetch-site': 'same-site' }, 403],
            [{ origin: ORIGIN }, 200],
            [{ origin: 'https://app.example.org' }, 200],
            [{ 'sec-fetch-site': 'same-origin' }, 200],
            [{ origin: 'https://evil.example.net', 'sec-fetch-site': 'same-origin' }, 403]
        ];
        for (const [headers, status] of cases) {
            const res = await call(MODE, '/api/auth/passcode', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...client(), ...headers },
                body: JSON.stringify({ passcode: ctx.secrets.passcode })
            });
            assert.equal(res.status, status, JSON.stringify(headers));
            if (status === 403) assertEnvelope(res, 403, 'csrf_rejected');
        }
    });

    it('CSRF also guards every cookie-authenticated POST', async () => {
        const headers = { ...cookieHeader(forgeCookie()), ...client() };
        const evil = await postJson(MODE, '/api/dropcowboy/token', { purpose: 'session' }, { ...headers, origin: 'https://evil.example.net' });
        assertEnvelope(evil, 403, 'csrf_rejected');
        const bare = await postJson(MODE, '/api/dropcowboy/token', { purpose: 'session' }, headers);
        assertEnvelope(bare, 403, 'csrf_rejected');
        assert.deepEqual(await mockRequests(), []);
        const ok = await postJson(MODE, '/api/dropcowboy/token', { purpose: 'session' }, { ...headers, origin: ORIGIN });
        assert.equal(ok.status, 200);
    });

    it('CSRF guards a cookie-authenticated DELETE too, such as removing a deal', async () => {
        const headers = { ...cookieHeader(forgeCookie()), ...client() };
        const path = '/api/modules/deals/' + crypto.randomUUID();
        const evil = await call(MODE, path, { method: 'DELETE', headers: { ...headers, origin: 'https://evil.example.net' } });
        assertEnvelope(evil, 403, 'csrf_rejected');
        assertEnvelope(await call(MODE, path, { method: 'DELETE', headers }), 403, 'csrf_rejected');
        // A trusted Origin gets past the check; the deal does not exist, so the answer is the module's own 404.
        assertEnvelope(await call(MODE, path, { method: 'DELETE', headers: { ...headers, origin: ORIGIN } }), 404, 'deal_not_found');
    });

    it('GET routes are not subject to the CSRF check', async () => {
        const res = await call(MODE, '/api/dropcowboy/readiness', {
            headers: { ...cookieHeader(forgeCookie()), origin: 'https://evil.example.net', ...client() }
        });
        assert.equal(res.status, 200);
    });

    it('a forged-but-correctly-signed cookie is accepted, so the documented format is the format', async () => {
        const sub = '8f3e1a9c-2d4b-4e7a-9c1f-5b6a7c8d9e0f';
        const res = await call(MODE, '/api/auth/session', { headers: cookieHeader(forgeCookie({ sub })) });
        assert.deepEqual(res.body.user, { id: sub });
    });

    it('expired, tampered, foreign and malformed cookies are simply signed out', async () => {
        const now = Math.floor(Date.now() / 1000);
        const good = forgeCookie();
        const [payload, mac] = good.split('.');
        const flipped = mac.slice(0, -2) + (mac.endsWith('AA') ? 'BB' : 'AA');
        const cookies = [
            forgeCookie({ iat: now - 100000, exp: now - 10 }),
            payload + '.' + flipped,
            forgeCookie({ passcode: 'a-different-passcode-entirely' }),
            forgeCookie({ siteId: crypto.randomUUID() }),
            b64(JSON.stringify({ v: 1, sub: 'x', iat: now, exp: now + 99 })) + '.' + mac,
            'not-a-cookie',
            '.',
            payload
        ];
        for (const value of cookies) {
            const res = await call(MODE, '/api/auth/session', { headers: cookieHeader(value) });
            assert.equal(res.status, 200);
            assert.equal(res.body.signed_in, false, value);
            assertEnvelope(await call(MODE, '/api/dropcowboy/readiness', { headers: cookieHeader(value) }), 401, 'unauthenticated');
        }
    });

    it('sign-out clears the cookie', async () => {
        const res = await postJson(MODE, '/api/auth/signout', {}, { ...cookieHeader(forgeCookie()), origin: ORIGIN, ...client() });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { signed_in: false });
        const [cookie] = setCookies(res);
        assert.match(cookie, new RegExp('^' + COOKIE + '=;'));
        assert.match(cookie, /Max-Age=0/i);
    });

    it('sign-out has the same CSRF and JSON rules', async () => {
        assertEnvelope(await postJson(MODE, '/api/auth/signout', {}, { origin: 'https://evil.example.net', ...client() }), 403, 'csrf_rejected');
        const res = await call(MODE, '/api/auth/signout', { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN, ...client() }, body: 'x' });
        assertEnvelope(res, 415, 'unsupported_media_type');
    });

    it('sign-in is limited to 10 a minute per client IP', async () => {
        const headers = client('198.51.100.91');
        for (let i = 0; i < 10; i++) {
            const res = await postJson(MODE, '/api/auth/passcode', { passcode: 'wrong-passcode-value' }, { origin: ORIGIN, ...headers });
            assertEnvelope(res, 401, 'invalid_passcode');
        }
        const limited = await postJson(MODE, '/api/auth/passcode', { passcode: ctx.secrets.passcode }, { origin: ORIGIN, ...headers });
        assertEnvelope(limited, 429, 'rate_limited');
        assert.match(limited.headers.get('retry-after'), /^[1-9][0-9]?$/);
        assert.ok(Number(limited.headers.get('retry-after')) <= 60);
        assert.deepEqual(setCookies(limited), []);

        const elsewhere = await signIn(ctx.secrets.passcode, client('198.51.100.92'));
        assert.equal(elsewhere.status, 200, 'another IP has its own counter');
    });

    it('the passcode never appears in a response body', async () => {
        const res = await signIn();
        assert.ok(!res.text.includes(ctx.secrets.passcode));
        const wrong = await signIn('wrong-passcode-value');
        assert.ok(!wrong.text.includes('wrong-passcode-value'));
    });
});
