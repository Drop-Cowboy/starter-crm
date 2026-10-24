// A throwaway OpenID Connect issuer for the oidc conformance cases.
//
// Keys are generated at run time and never written to disk, so no private key
// is ever committed. The issuer serves /.well-known/openid-configuration and a
// key set, counts how often each is fetched, and signs test tokens.

import crypto from 'node:crypto';
import http from 'node:http';

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

/**
 * Generates one signing key.
 *
 * @param {'RS256'|'ES256'} alg The algorithm the key signs with.
 * @param {string} [kid] The key id; a UUID by default.
 * @returns {{ alg: string, kid: string, privateKey: crypto.KeyObject, jwk: object }} The key.
 */
export function generateKey(alg = 'RS256', kid = crypto.randomUUID()) {
    const { publicKey, privateKey } = alg === 'ES256'
        ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' };
    return { alg, kid, privateKey, jwk };
}

/**
 * Builds a compact JWS by hand, so the tests can also build tokens that a
 * library would refuse to sign (`alg: none`, tampered payloads).
 *
 * @param {object} options What to put in the token.
 * @param {object} options.claims The payload.
 * @param {object} [options.key] A key from {@link generateKey}; omitted for an unsigned token.
 * @param {string} [options.alg] Overrides the header `alg`.
 * @param {string} [options.kid] Overrides the header `kid`.
 * @returns {string} The token.
 */
export function signJwt({ claims, key, alg, kid }) {
    const header = { alg: alg || (key && key.alg) || 'none', typ: 'JWT' };
    if (kid || (key && key.kid)) header.kid = kid || key.kid;
    const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
    if (!key || header.alg === 'none') return signingInput + '.';
    const signature = key.alg === 'ES256'
        ? crypto.sign('sha256', Buffer.from(signingInput), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
        : crypto.sign('sha256', Buffer.from(signingInput), key.privateKey);
    return signingInput + '.' + base64url(signature);
}

/**
 * Signs with HS256, the classic algorithm-confusion attack: the "secret" is
 * the issuer's public key material, which an attacker can read.
 *
 * @param {object} options What to put in the token.
 * @param {object} options.claims The payload.
 * @param {string} options.secret The HMAC secret.
 * @param {string} [options.kid] The key id header.
 * @returns {string} The token.
 */
export function signHs256({ claims, secret, kid }) {
    const header = { alg: 'HS256', typ: 'JWT' };
    if (kid) header.kid = kid;
    const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
    return signingInput + '.' + crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Starts an issuer on `port`.
 *
 * @param {number} port The port to listen on; the harness reserved it before the server booted.
 * @param {string} audience The audience tokens from {@link claims} carry.
 * @returns {Promise<object>} The issuer: `issuer`, `keys`, `claims()`, `token()`, `addKey()`, `fetches`, `close()`.
 */
export function startIssuer(port, audience) {
    const issuer = 'http://127.0.0.1:' + port;
    const state = {
        keys: [generateKey('RS256'), generateKey('ES256')],
        fetches: { discovery: 0, jwks: 0 }
    };

    const server = http.createServer((req, res) => {
        if (req.url === '/.well-known/openid-configuration') {
            state.fetches.discovery++;
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ issuer, jwks_uri: issuer + '/jwks.json' }));
        }
        if (req.url === '/jwks.json') {
            state.fetches.jwks++;
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ keys: state.keys.map((key) => key.jwk) }));
        }
        res.statusCode = 404;
        return res.end('not found');
    });

    const api = {
        issuer,
        audience,
        get keys() { return state.keys; },
        fetches: state.fetches,
        addKey(alg = 'RS256') {
            const key = generateKey(alg);
            state.keys.push(key);
            return key;
        },
        /** Claims a valid token carries; override any of them. */
        claims(overrides = {}) {
            const now = Math.floor(Date.now() / 1000);
            return { iss: issuer, aud: audience, sub: crypto.randomUUID(), iat: now, exp: now + 300, ...overrides };
        },
        /** A signed token with valid claims unless overridden. */
        token({ key = state.keys[0], claims = {}, ...rest } = {}) {
            return signJwt({ claims: api.claims(claims), key, ...rest });
        },
        close() {
            return new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            });
        }
    };

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(api));
    });
}
