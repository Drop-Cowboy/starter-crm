import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { assertEnvelope, call, ctx, mockRequests, postJson, resetMock, sleep, uuidv5 } from '../lib/context.js';
import { generateKey, signHs256, signJwt, startIssuer } from '../lib/jwks.js';

const MODE = 'oidc';
let issuer;

before(async () => {
    issuer = await startIssuer(ctx.oidc.port, ctx.oidc.audience);
});
after(async () => {
    await issuer.close().catch(() => {});
});
beforeEach(resetMock);

const asBearer = (token) => ({ authorization: 'Bearer ' + token });
const mint = (token, purpose = 'session') => postJson(MODE, '/api/dropcowboy/token', { purpose }, asBearer(token));

describe('oidc identity', () => {
    it('no token is 401 unauthenticated with a Bearer challenge', async () => {
        const res = await postJson(MODE, '/api/dropcowboy/token', { purpose: 'session' });
        assertEnvelope(res, 401, 'unauthenticated');
        assert.match(res.headers.get('www-authenticate'), /^Bearer/);
        const basic = await call(MODE, '/api/dropcowboy/readiness', { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
        assertEnvelope(basic, 401, 'unauthenticated');
        assert.deepEqual(await mockRequests(), []);
    });

    it('the session endpoint reports signed out without a token, never 401', async () => {
        const res = await call(MODE, '/api/auth/session');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { identity: 'oidc', signed_in: false, user: null });
    });

    it('a valid RS256 token mints for the token subject', async () => {
        const sub = crypto.randomUUID();
        const res = await mint(issuer.token({ claims: { sub } }));
        assert.equal(res.status, 200);
        const [upstream] = await mockRequests();
        assert.equal(upstream.body.sub, sub);
    });

    it('a valid ES256 token is accepted too', async () => {
        const key = issuer.keys.find((k) => k.alg === 'ES256');
        const sub = crypto.randomUUID();
        const res = await mint(issuer.token({ key, claims: { sub } }));
        assert.equal(res.status, 200);
        const [upstream] = await mockRequests();
        assert.equal(upstream.body.sub, sub);
    });

    it('a subject that is not a UUID maps to UUIDv5(site id, issuer|sub)', async () => {
        const sub = 'auth0|abc123';
        const res = await mint(issuer.token({ claims: { sub } }));
        assert.equal(res.status, 200);
        const [upstream] = await mockRequests();
        assert.equal(upstream.body.sub, uuidv5(ctx.siteId, issuer.issuer + '|' + sub));
    });

    it('the session endpoint returns the user, with email and name when the token has them', async () => {
        const sub = crypto.randomUUID();
        const token = issuer.token({ claims: { sub, email: 'pat@example.com', name: 'Pat Example' } });
        const res = await call(MODE, '/api/auth/session', { headers: asBearer(token) });
        assert.deepEqual(res.body, { identity: 'oidc', signed_in: true, user: { id: sub, email: 'pat@example.com', name: 'Pat Example' } });
    });

    it('aud may be a list that includes the audience', async () => {
        const res = await mint(issuer.token({ claims: { aud: ['https://other.example.org', issuer.audience] } }));
        assert.equal(res.status, 200);
    });

    it('rejects every bad token with 401 invalid_token', async () => {
        const now = Math.floor(Date.now() / 1000);
        const rs = issuer.keys[0];
        const good = issuer.token();
        const [header, payload, signature] = good.split('.');
        const tamperedClaims = Buffer.from(JSON.stringify({ ...issuer.claims(), sub: crypto.randomUUID() })).toString('base64url');
        const hmac = signHs256({ claims: issuer.claims(), secret: JSON.stringify(rs.jwk), kid: rs.kid });

        const bad = {
            expired: issuer.token({ claims: { exp: now - 120 } }),
            'wrong issuer': issuer.token({ claims: { iss: 'https://evil.example.net' } }),
            'wrong audience': issuer.token({ claims: { aud: 'someone-else' } }),
            'audience list without ours': issuer.token({ claims: { aud: ['a', 'b'] } }),
            'missing exp': signJwt({ key: rs, claims: { iss: issuer.issuer, aud: issuer.audience, sub: crypto.randomUUID() } }),
            'not yet valid': issuer.token({ claims: { nbf: now + 600 } }),
            tampered: header + '.' + tamperedClaims + '.' + signature,
            'alg none': signJwt({ claims: issuer.claims(), alg: 'none' }),
            'alg none with a kid': signJwt({ claims: issuer.claims(), alg: 'none', kid: rs.kid }),
            'alg HS256': hmac,
            'unknown kid': issuer.token({ key: generateKey('RS256') }),
            'not a jwt': 'not-a-jwt',
            'two segments': header + '.' + payload,
            'empty signature': header + '.' + payload + '.'
        };
        for (const [label, token] of Object.entries(bad)) {
            const res = await mint(token);
            assert.equal(res.status, 401, label + ': ' + JSON.stringify(res.body));
            assertEnvelope(res, 401, 'invalid_token');
            assert.match(res.headers.get('www-authenticate'), /^Bearer/, label);
        }
        assert.deepEqual(await mockRequests(), [], 'Drop Cowboy is never called for a rejected token');
    });

    it('allows 60 seconds of clock skew on exp', async () => {
        const now = Math.floor(Date.now() / 1000);
        const res = await mint(issuer.token({ claims: { exp: now - 30 } }));
        assert.equal(res.status, 200);
    });

    it('the token never appears in a response', async () => {
        const token = issuer.token();
        const res = await mint(token);
        assert.ok(!res.text.includes(token));
    });

    it('keeps the key set cached between requests', async () => {
        await mint(issuer.token());
        const before = issuer.fetches.jwks;
        for (let i = 0; i < 3; i++) await mint(issuer.token());
        assert.equal(issuer.fetches.jwks, before, 'a known kid must not refetch the key set');
    });

    it('picks up a rotated-in key once the refetch cooldown has passed', async () => {
        const key = issuer.addKey('RS256');
        await sleep(2100);
        const res = await mint(issuer.token({ key }));
        assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('with the issuer down, cached keys keep working and an unknown key is 503 identity_unavailable', async () => {
        const sub = crypto.randomUUID();
        const known = issuer.token({ claims: { sub } });
        await issuer.close();
        await sleep(2100);
        assert.equal((await mint(known)).status, 200, 'cached key still verifies');
        const unknown = await mint(issuer.token({ key: generateKey('RS256') }));
        assertEnvelope(unknown, 503, 'identity_unavailable');
    });
});
