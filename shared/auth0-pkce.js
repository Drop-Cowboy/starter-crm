import { errorFromResponse, networkError } from './errors.js';

// OAuth 2.0 Authorization Code flow with PKCE (RFC 7636), for a public
// single-page client. There is no client secret: the browser proves it is the
// same party that started the sign-in by revealing a random "code verifier"
// whose SHA-256 hash ("code challenge") it sent at the start.

// Minting site tokens needs numbers:write; the setup checklist (readiness)
// needs balance:read. openid profile identify the user.
export const LOGIN_SCOPE = 'openid profile numbers:write balance:read';

function base64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A URL-safe random string from `byteLength` random bytes. */
export function randomString(byteLength) {
    const bytes = new Uint8Array(byteLength || 32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
}

/** 32 random bytes give a 43-character verifier, the minimum RFC 7636 allows. */
export function createCodeVerifier() {
    return randomString(32);
}

/** S256 challenge: base64url(SHA-256(verifier)). */
export async function codeChallengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
}

/**
 * @param {{ domain: string, clientId: string, audience: string, redirectUri: string, state: string, codeChallenge: string }} p
 */
export function buildAuthorizeUrl(p) {
    const url = new URL('https://' + p.domain + '/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', p.clientId);
    url.searchParams.set('redirect_uri', p.redirectUri);
    url.searchParams.set('audience', p.audience);
    url.searchParams.set('scope', LOGIN_SCOPE);
    url.searchParams.set('state', p.state);
    url.searchParams.set('code_challenge', p.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
}

/**
 * Reads what the sign-in page sent back on the redirect URL. The `code` is a
 * one-time value, useless without the verifier; it is not a token.
 * @param {string} href
 * @returns {{ code: string, state: string } | { error: string, description: string } | null}
 */
export function readCallback(href) {
    const params = new URL(href).searchParams;
    if (params.get('error')) {
        return { error: params.get('error'), description: params.get('error_description') || '' };
    }
    if (params.get('code') && params.get('state')) {
        return { code: params.get('code'), state: params.get('state') };
    }
    return null;
}

/**
 * Trades the one-time code and the verifier for an access token.
 * @param {{ domain: string, clientId: string, code: string, verifier: string, redirectUri: string, fetch?: typeof fetch }} p
 * @returns {Promise<{ accessToken: string, expiresAt: number }>}
 */
export async function exchangeCode(p) {
    const fetchImpl = p.fetch || globalThis.fetch;
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: p.clientId,
        code: p.code,
        code_verifier: p.verifier,
        redirect_uri: p.redirectUri
    });
    let response;
    try {
        response = await fetchImpl('https://' + p.domain + '/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
    } catch {
        throw networkError();
    }
    if (!response.ok) {
        throw await errorFromResponse(response);
    }
    const json = await response.json();
    return {
        accessToken: json.access_token,
        expiresAt: Date.now() + (Number(json.expires_in) || 0) * 1000
    };
}
