import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildAuthorizeUrl,
    codeChallengeFor,
    createCodeVerifier,
    exchangeCode,
    LOGIN_SCOPE,
    readCallback
} from '../auth0-pkce.js';
import { jsonResponse, scriptedFetch } from './helpers.js';

describe('PKCE', () => {
    it('matches the RFC 7636 appendix B test vector', async () => {
        const challenge = await codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
        assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('makes 43-character URL-safe verifiers that differ every time', () => {
        const a = createCodeVerifier();
        const b = createCodeVerifier();
        assert.equal(a.length, 43);
        assert.match(a, /^[A-Za-z0-9_-]+$/);
        assert.notEqual(a, b);
    });

    it('builds the authorize URL with S256 and the minting scope', () => {
        const url = new URL(buildAuthorizeUrl({
            domain: 'login.dropcowboy.com',
            clientId: 'public-client',
            audience: 'https://api-v2.dropcowboy.com',
            redirectUri: 'http://localhost:8080/',
            state: 'state-1',
            codeChallenge: 'challenge-1'
        }));
        assert.equal(url.origin + url.pathname, 'https://login.dropcowboy.com/authorize');
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
        assert.equal(url.searchParams.get('scope'), LOGIN_SCOPE);
        assert.equal(LOGIN_SCOPE, 'openid profile numbers:write balance:read');
    });

    it('reads a callback, an error callback, or nothing', () => {
        assert.deepEqual(readCallback('http://localhost/?code=c1&state=s1'), { code: 'c1', state: 's1' });
        assert.deepEqual(readCallback('http://localhost/?error=access_denied&error_description=No'), { error: 'access_denied', description: 'No' });
        assert.equal(readCallback('http://localhost/contacts'), null);
    });

    it('exchanges the code with the verifier and no secret', async () => {
        const fetch = scriptedFetch([() => jsonResponse(200, { access_token: 'access-1', expires_in: 600, token_type: 'Bearer' })]);
        const before = Date.now();
        const result = await exchangeCode({
            domain: 'login.dropcowboy.com',
            clientId: 'public-client',
            code: 'c1',
            verifier: 'v1',
            redirectUri: 'http://localhost:8080/',
            fetch
        });
        assert.equal(result.accessToken, 'access-1');
        assert.ok(result.expiresAt >= before + 600000);
        const call = fetch.calls[0];
        assert.equal(call.url, 'https://login.dropcowboy.com/oauth/token');
        const body = new URLSearchParams(call.init.body);
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('code_verifier'), 'v1');
        assert.equal(body.get('client_secret'), null);
    });

    it('turns a refused exchange into an AppError', async () => {
        const fetch = scriptedFetch([() => jsonResponse(403, { error: 'invalid_grant', error_description: 'Bad code' })]);
        await assert.rejects(
            exchangeCode({ domain: 'd', clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'r', fetch }),
            { code: 'invalid_grant' }
        );
    });
});
