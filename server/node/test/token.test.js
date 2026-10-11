import { afterEach, describe, expect, it } from 'vitest';
import { PURPOSE_SCOPES, scopesForPurpose } from '../src/token.js';
import { API_KEY, API_SECRET, SITE_ID, USER_ID, fakeFetch, jsonResponse, makeConfig, startApp } from './helpers.js';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
const ACCESS_TOKEN = 'unit-test-access-token-0004';

describe('scopesForPurpose', () => {
    it('maps each purpose to its fixed scopes', () => {
        expect(scopesForPurpose('session')).toEqual(['dialer:webrtc', 'contacts']);
        expect(scopesForPurpose('contacts')).toEqual(['contacts']);
        expect(scopesForPurpose('campaigns')).toEqual(['campaigns']);
        expect(scopesForPurpose('phone')).toEqual(['phone:hub']);
    });

    it('gives the contacts purpose no calling scope, so it never hits the carrier or balance check', () => {
        expect(scopesForPurpose('contacts')).not.toContain('dialer:webrtc');
        expect(scopesForPurpose('contacts')).not.toContain('phone:hub');
    });

    it('rejects unknown purposes, prototype keys and non-strings', () => {
        for (const purpose of ['admin', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', null, 42, ['session'], { purpose: 'session' }]) {
            expect(scopesForPurpose(purpose)).toBeNull();
        }
    });

    it('returns a copy the caller cannot use to change the allowlist', () => {
        const scopes = scopesForPurpose('phone');
        scopes.push('numbers:write');
        expect(PURPOSE_SCOPES.phone).toEqual(['phone:hub']);
        expect(Object.isFrozen(PURPOSE_SCOPES)).toBe(true);
    });
});

describe('POST /api/dropcowboy/token', () => {
    let app;
    afterEach(() => app && app.close());

    const success = () => jsonResponse(200, {
        data: { token: TOKEN, expires_at: 1790000000000, jti: '0b6f2a1c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', pool_id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b' }
    });

    async function post(body, fetchImpl) {
        app = await startApp(makeConfig(), { fetch: fetchImpl });
        return fetch(app.url + '/api/dropcowboy/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body)
        });
    }

    it('mints with the API key and returns only token and expires_at', async () => {
        const upstream = fakeFetch(success);
        const res = await post({ purpose: 'session' }, upstream);

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ token: TOKEN, expires_at: 1790000000000 });

        const call = upstream.calls[0];
        expect(call.url).toBe('https://api.example.test/phone/public/embed/token');
        expect(call.method).toBe('POST');
        expect(call.headers['x-key']).toBe(API_KEY);
        expect(call.headers['x-secret']).toBe(API_SECRET);
        expect(call.body).toEqual({ site_id: SITE_ID, sub: USER_ID, scope: ['dialer:webrtc', 'contacts'], ttl_seconds: 900 });
    });

    it('ignores scope, sub, site_id and ttl sent by the browser', async () => {
        const upstream = fakeFetch(success);
        await post({ purpose: 'campaigns', scope: ['numbers:write'], sub: 'someone-else', site_id: 'other', ttl_seconds: 86400 }, upstream);
        expect(upstream.calls[0].body).toEqual({ site_id: SITE_ID, sub: USER_ID, scope: ['campaigns'], ttl_seconds: 900 });
    });

    it.each([
        [{ purpose: 'admin' }],
        [{ purpose: 'constructor' }],
        [{}],
        [[]]
    ])('answers 400 invalid_purpose for %j without calling upstream', async (body) => {
        const upstream = fakeFetch(success);
        const res = await post(body, upstream);
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('invalid_purpose');
        expect(upstream.calls).toHaveLength(0);
    });

    it('names every purpose in the invalid_purpose message', async () => {
        const res = await post({ purpose: 'admin' }, fakeFetch(success));
        expect((await res.json()).error.message).toBe('purpose must be one of: session, contacts, campaigns, phone');
    });

    it('mints the contacts purpose with only the contacts scope', async () => {
        const upstream = fakeFetch(success);
        const res = await post({ purpose: 'contacts' }, upstream);
        expect(res.status).toBe(200);
        expect(upstream.calls[0].body).toEqual({ site_id: SITE_ID, sub: USER_ID, scope: ['contacts'], ttl_seconds: 900 });
    });

    it('answers 400 invalid_json for a malformed body', async () => {
        const res = await post('{"purpose":', fakeFetch(success));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } });
    });

    it('answers 502 when upstream success lacks a token', async () => {
        const res = await post({ purpose: 'session' }, fakeFetch(() => jsonResponse(200, { data: {} })));
        expect(res.status).toBe(502);
        expect((await res.json()).error.code).toBe('upstream_error');
    });

    it('sends the API key, never a bearer the browser sent', async () => {
        const upstream = fakeFetch(success);
        app = await startApp(makeConfig(), { fetch: upstream });
        await fetch(app.url + '/api/dropcowboy/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + ACCESS_TOKEN },
            body: JSON.stringify({ purpose: 'session' })
        });
        expect(upstream.calls[0].headers['x-key']).toBe(API_KEY);
        expect(upstream.calls[0].headers.authorization).toBeUndefined();
    });

    it('answers 502 upstream_auth_failed when Drop Cowboy refuses the API key', async () => {
        const res = await post({ purpose: 'session' }, fakeFetch(() => jsonResponse(401, { title: 'Unauthorized' })));
        expect(res.status).toBe(502);
        expect((await res.json()).error.code).toBe('upstream_auth_failed');
    });

    it('is not registered in mcp-session mode', async () => {
        app = await startApp(makeConfig({ DC_AUTH_MODE: 'mcp-session' }), { fetch: fakeFetch(success) });
        const res = await fetch(app.url + '/api/dropcowboy/token', { method: 'POST' });
        expect(res.status).toBe(404);
        expect((await res.json()).error.code).toBe('not_found');
    });
});

describe('POST /api/dropcowboy/token in login mode', () => {
    let app;
    afterEach(() => app && app.close());

    const success = () => jsonResponse(200, { data: { token: TOKEN, expires_at: 1790000000000 } });

    async function post(body, fetchImpl, authorization = 'Bearer ' + ACCESS_TOKEN) {
        app = await startApp(makeConfig({ DC_AUTH_MODE: 'login' }), { fetch: fetchImpl });
        const headers = { 'content-type': 'application/json' };
        if (authorization !== null) headers.authorization = authorization;
        return fetch(app.url + '/api/dropcowboy/token', { method: 'POST', headers, body: JSON.stringify(body) });
    }

    it('forwards the access token instead of the API key, with no sub', async () => {
        const upstream = fakeFetch(success);
        const res = await post({ purpose: 'phone', sub: 'someone-else', scope: ['numbers:write'], ttl_seconds: 86400 }, upstream);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ token: TOKEN, expires_at: 1790000000000 });
        const call = upstream.calls[0];
        expect(call.headers.authorization).toBe('Bearer ' + ACCESS_TOKEN);
        expect(call.headers['x-key']).toBeUndefined();
        expect(call.headers['x-secret']).toBeUndefined();
        expect(call.body).toEqual({ site_id: SITE_ID, scope: ['phone:hub'], ttl_seconds: 900 });
    });

    it('accepts the scheme in any case and forwards it as Bearer', async () => {
        const upstream = fakeFetch(success);
        await post({ purpose: 'session' }, upstream, 'bearer ' + ACCESS_TOKEN);
        expect(upstream.calls[0].headers.authorization).toBe('Bearer ' + ACCESS_TOKEN);
    });

    it.each([
        ['no Authorization header', null],
        ['another scheme', 'Basic dXNlcjpwYXNz'],
        ['an empty bearer', 'Bearer '],
        ['two tokens', 'Bearer one two']
    ])('answers 401 login_required for %s without calling upstream', async (label, authorization) => {
        const upstream = fakeFetch(success);
        const res = await post({ purpose: 'session' }, upstream, authorization);
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('login_required');
        expect(upstream.calls).toHaveLength(0);
    });

    it('answers 401 login_expired when Drop Cowboy refuses the token, without echoing it', async () => {
        const res = await post({ purpose: 'session' }, fakeFetch(() => jsonResponse(401, { title: 'Unauthorized' })));
        expect(res.status).toBe(401);
        const text = await res.text();
        expect(JSON.parse(text).error.code).toBe('login_expired');
        expect(text).not.toContain(ACCESS_TOKEN);
    });
});
