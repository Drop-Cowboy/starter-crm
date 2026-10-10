import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

if (!process.env.CONFORMANCE_CONTEXT) {
    throw new Error('Run the suite through run.js, which boots the servers: node run.js');
}

export const ctx = JSON.parse(process.env.CONFORMANCE_CONTEXT);

export function urlFor(mode, path) {
    return ctx.servers[mode].url + path;
}

// fetch, with the body parsed when it is JSON.
export async function call(mode, path, init = {}) {
    const res = await fetch(urlFor(mode, path), init);
    const text = await res.text();
    let body = text;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
        body = JSON.parse(text);
    }
    return { status: res.status, headers: res.headers, body, text };
}

export function postJson(mode, path, body, headers = {}) {
    return call(mode, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
}

// The header a login-mode browser sends after signing in with Drop Cowboy.
export function bearer(token = ctx.secrets.accessToken) {
    return { authorization: 'Bearer ' + token };
}

// A raw HTTP request, for headers fetch won't let you set (Host) and paths it
// would normalise (../).
export function rawRequest(mode, { path, headers = {} }) {
    const { hostname, port } = new URL(ctx.servers[mode].url);
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname, port, path, headers, method: 'GET' }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let body = text;
                if ((res.headers['content-type'] || '').includes('application/json')) body = JSON.parse(text);
                resolve({ status: res.statusCode, headers: res.headers, body, text });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

export function assertEnvelope(res, status, code) {
    assert.equal(res.status, status, 'status for ' + JSON.stringify(res.body));
    assert.match(res.headers.get ? res.headers.get('content-type') : res.headers['content-type'], /application\/json/);
    assert.deepEqual(Object.keys(res.body), ['error'], 'body must be exactly { error }');
    assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message']);
    assert.equal(typeof res.body.error.message, 'string');
    assert.ok(res.body.error.message.length > 0, 'message must not be empty');
    if (code) assert.equal(res.body.error.code, code);
}

export async function mockScenario(route, scenario) {
    const res = await fetch(ctx.mock + '/__mock/scenario', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route, scenario })
    });
    assert.equal(res.status, 200, 'mock scenario ' + scenario);
}

export async function resetMock() {
    await fetch(ctx.mock + '/__mock/reset', { method: 'POST' });
}

export async function mockRequests() {
    return (await fetch(ctx.mock + '/__mock/requests')).json();
}

export function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

export function signature(rawBody, secret, timestamp) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
}

// Delivers `rawBody` the way Drop Cowboy does. Override any header to break it.
export function deliver(mode, rawBody, overrides = {}) {
    const timestamp = overrides.timestamp !== undefined ? overrides.timestamp : String(nowSeconds());
    const secret = overrides.secret || ctx.secrets.webhookSecret;
    const headers = {
        'content-type': 'application/json',
        'user-agent': 'DropCowboy-Webhook/1.0',
        'x-signature': signature(rawBody, secret, timestamp),
        'x-timestamp': timestamp,
        'x-signature-version': 'v1',
        'x-attempt': '1',
        ...overrides.headers
    };
    for (const [name, value] of Object.entries(headers)) {
        if (value === null) delete headers[name];
    }
    return call(mode, '/webhooks/dropcowboy', { method: 'POST', headers, body: rawBody });
}

export function eventBody(eventId, event = 'contact.msg.received') {
    return JSON.stringify({
        event_id: eventId,
        event,
        event_at: Date.now(),
        data: { contact_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', body: 'Yes, call me back', from: '+13125550142' }
    });
}
