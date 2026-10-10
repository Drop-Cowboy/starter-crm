import crypto from 'node:crypto';
import http from 'node:http';

// A stand-in for the Drop Cowboy API. It records every request and answers
// with the scenario each test selects through the /__mock/* control routes.

// Planted in every error body. It must never reach a browser.
export const CANARY = 'UPSTREAM-RAW-BODY-CANARY';

// Shaped like a JWT so it also exercises log redaction. Not a real token.
export const MOCK_TOKEN = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJjb25mb3JtYW5jZSI6dHJ1ZX0.bW9jay1zaWduYXR1cmU';

export const READINESS_DATA = {
    building_blocks_enabled: true,
    usage_plan: 'developer-plan',
    byoc: {
        connected: true,
        providers: [{
            provider: 'twilio',
            integration_type: 'twilio',
            integration_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
            enabled: true,
            default: true,
            pool_id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
        }],
        pool_id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
    },
    pool_id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
    numbers: { count: 1, items: [{ number_id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', phone_number: '+13125550142', name: 'Main line' }] },
    voices: { count: 0 },
    agents: { count: 0, published: 0 },
    funds: { available: 25, balance: 30, reserved: 5, funds_ok: true },
    allotment: {
        sms: { remaining: 480, cap: 500 },
        dialer_minutes: { remaining: 100, cap: 100 }
    },
    embed_ready: false,
    next_actions: ['rent_number'],
    embed_resolve_contact_consent: true
};

function problem(status, slug, detail) {
    return {
        status,
        body: {
            type: 'https://api-v2.dropcowboy.com/errors/' + slug,
            title: slug,
            status,
            detail,
            instance: CANARY,
            request_id: crypto.randomUUID()
        }
    };
}

function successFor(route) {
    if (route === 'token') {
        return {
            status: 200,
            body: {
                data: { token: MOCK_TOKEN, expires_at: Date.now() + 900000, jti: crypto.randomUUID(), pool_id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b' },
                meta: { request_id: crypto.randomUUID() }
            }
        };
    }
    return { status: 200, body: { data: READINESS_DATA, meta: { request_id: crypto.randomUUID() } } };
}

const SCENARIOS = {
    success: (route) => successFor(route),
    payment_required: () => problem(402, 'payment-required', 'Add funds to continue.'),
    insufficient_scope: () => problem(403, 'insufficient-scope', 'This endpoint requires one of: numbers:write'),
    consent_required: () => ({
        status: 403,
        body: { message: 'A valid consent_id is required for this embed send', detail: { code: 'consent_required', debug: CANARY } }
    }),
    unauthorized: () => problem(401, 'unauthorized', 'Invalid API key or secret'),
    rate_limited: () => ({ ...problem(429, 'too-many-requests', 'Slow down.'), headers: { 'retry-after': '7' } }),
    server_error: () => problem(500, 'server-error', 'Stack trace with ' + CANARY),
    not_json: () => ({ status: 502, raw: '<html><body>Bad gateway ' + CANARY + '</body></html>', headers: { 'content-type': 'text/html' } }),
    bad_success: () => ({ status: 200, body: { data: { note: CANARY } } }),
    slow: (route, delayMs) => ({ ...successFor(route), delayMs })
};

const ROUTES = {
    'POST /phone/public/embed/token': 'token',
    'GET /register/public/integration-readiness': 'readiness'
};

// Which kind of credentials a request carried. A server must send exactly
// one: its API key in server mode, the user's bearer in login mode.
export function credentialsOf(headers) {
    const apiKey = headers['x-key'] !== undefined || headers['x-secret'] !== undefined;
    const bearer = headers.authorization !== undefined;
    if (apiKey && bearer) return 'both';
    if (apiKey) return 'api_key';
    if (bearer) return 'bearer';
    return 'none';
}

// Like Drop Cowboy, answers 401 unless the request carries exactly one valid
// credential: the configured API key and secret, or a known access token.
function authenticated(headers, { apiKey, apiSecret, accessTokens }) {
    const kind = credentialsOf(headers);
    if (kind === 'api_key') return headers['x-key'] === apiKey && headers['x-secret'] === apiSecret;
    if (kind === 'bearer') return accessTokens.some((token) => headers.authorization === 'Bearer ' + token);
    return false;
}

export function startMock({ slowDelayMs = 5000, apiKey, apiSecret, accessTokens = [] } = {}) {
    let scenarios = { token: 'success', readiness: 'success' };
    let requests = [];

    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        const url = new URL(req.url, 'http://mock');

        if (url.pathname === '/__mock/reset' && req.method === 'POST') {
            scenarios = { token: 'success', readiness: 'success' };
            requests = [];
            return send(res, { status: 200, body: { ok: true } });
        }
        if (url.pathname === '/__mock/scenario' && req.method === 'POST') {
            const { route, scenario } = JSON.parse(raw || '{}');
            if (!Object.hasOwn(scenarios, route) || !Object.hasOwn(SCENARIOS, scenario)) {
                return send(res, { status: 400, body: { error: 'unknown route or scenario' } });
            }
            scenarios[route] = scenario;
            return send(res, { status: 200, body: { ok: true } });
        }
        if (url.pathname === '/__mock/requests' && req.method === 'GET') {
            return send(res, { status: 200, body: requests });
        }

        const route = ROUTES[req.method + ' ' + url.pathname];
        requests.push({
            method: req.method,
            path: url.pathname,
            headers: req.headers,
            credentials: credentialsOf(req.headers),
            body: parseJson(raw)
        });
        if (!route) {
            return send(res, problem(404, 'not-found', 'No route matches ' + req.method + ' ' + url.pathname));
        }
        if (!authenticated(req.headers, { apiKey, apiSecret, accessTokens })) {
            return send(res, problem(401, 'unauthorized', 'Invalid or missing credentials'));
        }
        const answer = SCENARIOS[scenarios[route]](route, slowDelayMs);
        if (answer.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
        }
        return send(res, answer);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: 'http://127.0.0.1:' + server.address().port,
                close: () => new Promise((done) => {
                    server.closeAllConnections();
                    server.close(done);
                })
            });
        });
    });
}

function send(res, { status, body, raw, headers = {} }) {
    if (res.destroyed) return;
    const payload = raw !== undefined ? raw : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
    });
}

function parseJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
