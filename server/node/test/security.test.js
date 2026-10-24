import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { applyCors, applySecurityHeaders, checkOrigin, contentSecurityPolicy } from '../src/security.js';
import { makeConfig } from './helpers.js';

function ctxFor(headers, config = makeConfig()) {
    return { request: new Request('http://127.0.0.1:8080/api/auth/passcode', { method: 'POST', headers }), config };
}

function rejection(ctx) {
    try {
        checkOrigin(ctx);
    } catch (err) {
        return err;
    }
    return null;
}

describe('checkOrigin (CSRF)', () => {
    it('accepts the request origin when no public URL is set', () => {
        expect(rejection(ctxFor({ origin: 'http://127.0.0.1:8080' }))).toBeNull();
    });

    it('rejects a foreign Origin with 403 csrf_rejected', () => {
        const err = rejection(ctxFor({ origin: 'https://evil.example.com' }));
        expect(err).toBeInstanceOf(HttpError);
        expect([err.status, err.code]).toEqual([403, 'csrf_rejected']);
    });

    it('accepts the DC_PUBLIC_URL origin and rejects the request origin once it is set', () => {
        const config = makeConfig({ DC_PUBLIC_URL: 'https://crm.example.com' });
        expect(rejection(ctxFor({ origin: 'https://crm.example.com' }, config))).toBeNull();
        expect(rejection(ctxFor({ origin: 'http://127.0.0.1:8080' }, config))).not.toBeNull();
    });

    it('accepts a DC_CORS_ORIGINS origin', () => {
        const config = makeConfig({ DC_CORS_ORIGINS: 'https://app.example.org' });
        expect(rejection(ctxFor({ origin: 'https://app.example.org' }, config))).toBeNull();
    });

    it('without Origin, accepts Sec-Fetch-Site same-origin or none only', () => {
        expect(rejection(ctxFor({ 'sec-fetch-site': 'same-origin' }))).toBeNull();
        expect(rejection(ctxFor({ 'sec-fetch-site': 'none' }))).toBeNull();
        expect(rejection(ctxFor({ 'sec-fetch-site': 'cross-site' }))).not.toBeNull();
        expect(rejection(ctxFor({ 'sec-fetch-site': 'same-site' }))).not.toBeNull();
        expect(rejection(ctxFor({}))).not.toBeNull();
    });
});

describe('security headers', () => {
    it('always sends the fixed headers and frame-ancestors none', () => {
        const response = new Response('x');
        applySecurityHeaders(response, makeConfig());
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('x-frame-options')).toBe('DENY');
        expect(response.headers.get('permissions-policy')).toBe('microphone=(self), camera=(), geolocation=()');
        const policy = response.headers.get('content-security-policy-report-only');
        expect(policy).toContain("frame-ancestors 'none'");
        expect(policy).toContain("object-src 'none'");
        expect(response.headers.get('strict-transport-security')).toBeNull();
    });

    it('names only public hosts in the policy', () => {
        const policy = contentSecurityPolicy(makeConfig());
        const hosts = policy.match(/https?:\/\/[^\s;]+/g);
        for (const host of hosts) expect(host).toMatch(/dropcowboy\.com$/);
    });

    it('enforces, or sends nothing, as configured, and adds HSTS in production', () => {
        const enforced = new Response('x');
        applySecurityHeaders(enforced, makeConfig({ DC_CSP: 'enforce' }));
        expect(enforced.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(enforced.headers.get('content-security-policy-report-only')).toBeNull();
        const off = new Response('x');
        applySecurityHeaders(off, makeConfig({ DC_CSP: 'off' }));
        expect(off.headers.get('content-security-policy')).toBeNull();
        expect(off.headers.get('content-security-policy-report-only')).toBeNull();
        const prod = new Response('x');
        applySecurityHeaders(prod, makeConfig({ DC_ENV: 'production', DC_IDENTITY: 'passcode', DC_PASSCODE: 'a-long-enough-passcode' }));
        expect(prod.headers.get('strict-transport-security')).toBe('max-age=31536000');
    });
});

describe('applyCors', () => {
    const config = makeConfig({ DC_CORS_ORIGINS: 'https://app.example.org' });

    it('echoes an allowed origin, with Vary and exposed headers and no credentials', () => {
        const response = new Response('x');
        applyCors(new Request('http://127.0.0.1/x', { headers: { origin: 'https://app.example.org' } }), response, config);
        expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
        expect(response.headers.get('vary')).toBe('Origin');
        expect(response.headers.get('access-control-expose-headers')).toBe('X-Request-Id, Retry-After');
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('sets nothing for any other origin, or none', () => {
        const other = new Response('x');
        applyCors(new Request('http://127.0.0.1/x', { headers: { origin: 'https://evil.example.com' } }), other, config);
        expect(other.headers.get('access-control-allow-origin')).toBeNull();
        const none = new Response('x');
        applyCors(new Request('http://127.0.0.1/x'), none, config);
        expect(none.headers.get('access-control-allow-origin')).toBeNull();
    });
});
