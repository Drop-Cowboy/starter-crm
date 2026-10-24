// Stand-ins for the secret managers the `doppler`, `infisical` and `vault`
// providers talk to, so the suite can prove a provider without an account.
//
// Where it sits: suite/19-secret-managers.test.js starts one of these on a free
// loopback port, points the server under test at it (DOPPLER_API_URL,
// INFISICAL_URL, VAULT_ADDR) and changes what it serves while the server runs.
// The providers accept plain http only for loopback, which is how these are reached.
//
// Each stub answers only what the real API documents for the calls the
// providers make, refuses a wrong credential the way the real one does, and
// records every request so a case can assert how many times a provider signed
// in. `fail(status)` makes every call answer that status until `fail(null)`.
// What they serve is plain data you can change: `secrets` for Doppler and
// Vault, `secrets` for Infisical.

import crypto from 'node:crypto';
import http from 'node:http';

/**
 * Starts an HTTP server from a request handler and wraps the bookkeeping the stubs share.
 *
 * @param {(req: http.IncomingMessage, url: URL, body: any, reply: Function) => void} handle The route table.
 * @returns {Promise<object>} `{ url, requests, fail, close }`.
 */
async function start(handle) {
    const state = { failing: null, requests: [] };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const url = new URL(req.url, 'http://stub');
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = null;
            }
            state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
            const reply = (status, payload) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            if (state.failing) {
                reply(state.failing, { error: 'stub failure' });
                return;
            }
            handle(req, url, body, reply);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        requests: state.requests,
        fail: (status) => { state.failing = status; },
        close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
    };
}

/**
 * A Doppler config behind a service token.
 *
 * @param {{ token: string, secrets: Record<string, string> }} options The token it accepts and what it serves.
 * @returns {Promise<object>} The stub; change `.secrets` to rotate a value.
 */
export async function startDoppler({ token, secrets }) {
    const stub = { secrets: { ...secrets } };
    const base = await start((req, url, body, reply) => {
        if (req.headers.authorization !== 'Bearer ' + token) return reply(401, { success: false, messages: ['Invalid Auth token'] });
        if (req.method === 'GET' && url.pathname === '/v3/configs/config/secrets/download' && url.searchParams.get('format') === 'json') {
            return reply(200, stub.secrets);
        }
        return reply(404, { success: false });
    });
    return Object.assign(stub, base);
}

/**
 * An Infisical project environment behind a machine identity (universal auth).
 *
 * @param {{ clientId: string, clientSecret: string, projectId: string, environment: string, secretPath?: string,
 *   secrets: Record<string, string>, expiresIn?: number }} options The identity it accepts, where the secrets
 *   live, what it serves, and the lifetime in seconds it gives access tokens.
 * @returns {Promise<object>} The stub; `.logins` counts sign-ins and `.revokeTokens()` invalidates every token issued.
 */
export async function startInfisical({ clientId, clientSecret, projectId, environment, secretPath = '/', secrets, expiresIn = 3600 }) {
    const stub = { secrets: { ...secrets }, logins: 0, tokens: new Set() };
    const base = await start((req, url, body, reply) => {
        if (req.method === 'POST' && url.pathname === '/api/v1/auth/universal-auth/login') {
            if (!body || body.clientId !== clientId || body.clientSecret !== clientSecret) return reply(401, { message: 'Invalid credentials' });
            const accessToken = 'infisical-access-' + crypto.randomUUID();
            stub.tokens.add(accessToken);
            stub.logins += 1;
            return reply(200, { accessToken, expiresIn, accessTokenMaxTTL: 2592000, tokenType: 'Bearer' });
        }
        if (req.method === 'GET' && url.pathname === '/api/v3/secrets/raw') {
            const presented = (req.headers.authorization || '').replace(/^Bearer /, '');
            if (!stub.tokens.has(presented)) return reply(401, { message: 'Token is not valid' });
            const q = url.searchParams;
            if (q.get('workspaceId') !== projectId || q.get('environment') !== environment || q.get('secretPath') !== secretPath) {
                return reply(404, { message: 'Project, environment or folder not found' });
            }
            return reply(200, {
                secrets: Object.entries(stub.secrets).map(([secretKey, secretValue]) => ({ secretKey, secretValue, type: 'shared' })),
                imports: []
            });
        }
        return reply(404, { message: 'not found' });
    });
    return Object.assign(stub, base, { revokeTokens: () => stub.tokens.clear() });
}

/**
 * A Vault (or OpenBao) KV v2 secret, reachable with a token or with AppRole.
 *
 * @param {{ token?: string, roleId?: string, secretId?: string, mount?: string, path: string,
 *   secrets: Record<string, string>, leaseSeconds?: number, namespace?: string }} options The credentials it
 *   accepts, where the secret lives, what it serves, and the lease in seconds it gives AppRole tokens.
 * @returns {Promise<object>} The stub; `.logins` counts AppRole logins and `.revokeTokens()` invalidates the AppRole tokens.
 */
export async function startVault({ token, roleId, secretId, mount = 'secret', path, secrets, leaseSeconds = 3600, namespace }) {
    const stub = { secrets: { ...secrets }, logins: 0, tokens: new Set(), version: 1 };
    const base = await start((req, url, body, reply) => {
        if (namespace && req.headers['x-vault-namespace'] !== namespace) return reply(403, { errors: ['namespace not found'] });
        if (req.method === 'POST' && url.pathname === '/v1/auth/approle/login') {
            if (!body || body.role_id !== roleId || body.secret_id !== secretId) return reply(400, { errors: ['invalid role or secret ID'] });
            const clientToken = 'vault-client-' + crypto.randomUUID();
            stub.tokens.add(clientToken);
            stub.logins += 1;
            return reply(200, { auth: { client_token: clientToken, lease_duration: leaseSeconds, renewable: true } });
        }
        if (req.method === 'GET' && url.pathname === '/v1/' + mount + '/data/' + path) {
            const presented = req.headers['x-vault-token'];
            if (presented !== token && !stub.tokens.has(presented)) return reply(403, { errors: ['permission denied'] });
            return reply(200, { data: { data: stub.secrets, metadata: { version: stub.version } } });
        }
        if (req.method === 'GET' && url.pathname.startsWith('/v1/' + mount + '/data/')) {
            const presented = req.headers['x-vault-token'];
            if (presented !== token && !stub.tokens.has(presented)) return reply(403, { errors: ['permission denied'] });
            return reply(404, { errors: [] });
        }
        return reply(404, { errors: ['unsupported path'] });
    });
    return Object.assign(stub, base, { revokeTokens: () => stub.tokens.clear() });
}

/**
 * Whether an AWS request was signed with the access key id this stand-in accepts.
 *
 * @param {http.IncomingMessage} req The request.
 * @param {string} accessKeyId The key id the stand-in accepts.
 * @returns {boolean} True when the SigV4 `Authorization` header names that key id.
 */
function signedWith(req, accessKeyId) {
    return (req.headers.authorization || '').includes('Credential=' + accessKeyId + '/');
}

/**
 * AWS Secrets Manager, one JSON secret, reachable with one access key. Speaks the JSON 1.1 protocol the SDKs use
 * (`X-Amz-Target: secretsmanager.GetSecretValue`).
 *
 * @param {{ accessKeyId: string, secretId: string, secrets: Record<string, string> }} options The key id it accepts,
 *   the secret's name and what the secret holds.
 * @returns {Promise<object>} The stub; change `.secrets` to rotate a value.
 */
export async function startAwsSecretsManager({ accessKeyId, secretId, secrets }) {
    const stub = { secrets: { ...secrets } };
    const base = await start((req, url, body, reply) => {
        if (!signedWith(req, accessKeyId)) return reply(400, { __type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' });
        if (req.method === 'POST' && req.headers['x-amz-target'] === 'secretsmanager.GetSecretValue') {
            if (!body || body.SecretId !== secretId) return reply(400, { __type: 'ResourceNotFoundException', message: 'Secrets Manager can\'t find the specified secret.' });
            return reply(200, { Name: secretId, VersionId: crypto.randomUUID(), SecretString: JSON.stringify(stub.secrets) });
        }
        return reply(400, { __type: 'UnknownOperationException', message: 'unsupported' });
    });
    return Object.assign(stub, base);
}

/**
 * AWS Systems Manager Parameter Store, a path of parameters, reachable with one access key. Speaks the JSON 1.1
 * protocol the SDKs use (`X-Amz-Target: AmazonSSM.GetParametersByPath`) and pages its answer.
 *
 * @param {{ accessKeyId: string, path: string, secrets: Record<string, string>, pageSize?: number }} options The key id
 *   it accepts, the path the parameters live under, what they hold, and how many it returns per page.
 * @returns {Promise<object>} The stub; change `.secrets` to rotate a value. A parameter one level deeper is served too, so a provider must ignore it.
 */
export async function startAwsSsm({ accessKeyId, path, secrets, pageSize = 2 }) {
    const stub = { secrets: { ...secrets } };
    const base = await start((req, url, body, reply) => {
        if (!signedWith(req, accessKeyId)) return reply(400, { __type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' });
        if (req.method === 'POST' && req.headers['x-amz-target'] === 'AmazonSSM.GetParametersByPath') {
            if (!body || body.Path !== path || body.WithDecryption !== true) return reply(200, { Parameters: [] });
            const all = Object.entries(stub.secrets).map(([name, value]) => ({ Name: path + '/' + name, Type: 'SecureString', Value: value, Version: 1 }));
            all.push({ Name: path + '/nested/DEEPER_SECRET', Type: 'SecureString', Value: 'deeper-' + crypto.randomUUID(), Version: 1 });
            const from = body.NextToken ? Number(body.NextToken) : 0;
            const page = all.slice(from, from + pageSize);
            const payload = { Parameters: page };
            if (from + pageSize < all.length) payload.NextToken = String(from + pageSize);
            return reply(200, payload);
        }
        return reply(400, { __type: 'UnknownOperationException', message: 'unsupported' });
    });
    return Object.assign(stub, base);
}
