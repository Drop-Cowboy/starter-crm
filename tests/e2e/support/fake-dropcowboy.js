import crypto from 'node:crypto';
import http from 'node:http';
import * as data from './data.js';

// One fake Drop Cowboy account, reached two ways:
//
//  - over HTTP by the starter server, which mints site tokens and reads the
//    setup checklist with its API key (or the signed-in user's token), and
//  - by the browser, whose calls to the widget API are intercepted by
//    Playwright and answered by `answerBrowser()`.
//
// Both sides share the tokens: the browser is only let in with a token the
// server minted, carrying the scope the endpoint needs. That is how the real
// service behaves, so a page that used the wrong token would fail here too.

export const WIDGET_API_ORIGIN = 'https://app-api-v2.dropcowboy.com';

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, accept, x-request-id',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '600'
};

export async function startFakeDropCowboy({ apiKey, apiSecret, accessTokens = [] }) {
    const fake = new FakeDropCowboy({ apiKey, apiSecret, accessTokens });
    await fake.listen();
    return fake;
}

class FakeDropCowboy {
    constructor({ apiKey, apiSecret, accessTokens }) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.accessTokens = accessTokens;
        this.everyToken = new Set();
        this.reset();
    }

    /** Back to the starting account, with no tokens and nothing recorded. */
    reset() {
        this.tokens = new Map();
        this.mints = [];
        this.calls = [];
        this.unhandled = [];
        this.mintRefusals = new Map();
        this.textRefusal = null;
        this.contacts = new Map();
        for (const contact of data.startingContacts()) {
            this.contacts.set(contact.contact_id, contact);
        }
    }

    // ---- What a test can arrange -------------------------------------------

    /** Mints whose scopes include `scope` are refused with `code`, as Drop Cowboy does for a team without a carrier. */
    refuseMints(scope, code) {
        this.mintRefusals.set(scope, code);
    }

    /** Every text is refused with `code` (e.g. consent_required). */
    refuseTexts(code) {
        this.textRefusal = code;
    }

    /** Makes every live token with `scope` stop working, as if it had expired early. */
    revokeTokens(scope) {
        for (const grant of this.tokens.values()) {
            if (grant.scope.includes(scope)) {
                grant.revoked = true;
            }
        }
    }

    // ---- What a test can inspect -------------------------------------------

    /** Mints for one purpose, named by its scopes, e.g. 'contacts' or 'dialer:webrtc contacts'. */
    mintsFor(scopes) {
        return this.mints.filter((mint) => mint.scope.join(' ') === scopes);
    }

    /** Browser calls to the widget API matching a method and a path (string prefix or RegExp). */
    callsTo(method, path) {
        return this.calls.filter((call) => call.method === method
            && (path instanceof RegExp ? path.test(call.path) : call.path.startsWith(path)));
    }

    /** Every token ever handed out, for the leak checks. */
    secrets() {
        return [...this.everyToken];
    }

    // ---- The server-side API (real HTTP) -----------------------------------

    listen() {
        this.server = http.createServer((req, res) => this.answerServer(req, res));
        return new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', () => {
                this.url = 'http://127.0.0.1:' + this.server.address().port;
                resolve();
            });
        });
    }

    close() {
        return new Promise((resolve) => {
            this.server.closeAllConnections();
            this.server.close(resolve);
        });
    }

    async answerServer(req, res) {
        const raw = await readBody(req);
        const path = new URL(req.url, 'http://fake').pathname;
        const reply = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        if (!this.serverIsAuthenticated(req.headers)) {
            return reply(401, problem(401, 'unauthorized', 'Invalid or missing credentials'));
        }
        if (req.method === 'POST' && path === '/phone/public/embed/token') {
            const answer = this.mint(parseJson(raw) || {}, req.headers);
            return reply(answer.status, answer.body);
        }
        if (req.method === 'GET' && path === '/register/public/integration-readiness') {
            return reply(200, { data: data.READINESS });
        }
        return reply(404, problem(404, 'not-found', 'No route matches ' + req.method + ' ' + path));
    }

    serverIsAuthenticated(headers) {
        if (headers.authorization) {
            return this.accessTokens.some((token) => headers.authorization === 'Bearer ' + token);
        }
        return headers['x-key'] === this.apiKey && headers['x-secret'] === this.apiSecret;
    }

    mint(body, headers) {
        const scope = Array.isArray(body.scope) ? body.scope : [];
        this.mints.push({ scope, siteId: body.site_id, sub: body.sub, viaLogin: !!headers.authorization });
        for (const [refusedScope, code] of this.mintRefusals) {
            if (scope.includes(refusedScope)) {
                return {
                    status: 403,
                    body: { message: 'Connect a carrier before minting tokens that call or text.', detail: { code } }
                };
            }
        }
        const expiresAt = Date.now() + (body.ttl_seconds || 900) * 1000;
        const token = fakeJwt({
            iss: 'https://app-api-v2.dropcowboy.com',
            sub: body.sub || data.STARTER_CRM_USER_ID,
            team_id: data.TEAM_ID,
            site_id: body.site_id,
            scope,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(expiresAt / 1000),
            jti: crypto.randomUUID()
        });
        this.tokens.set(token, { scope, revoked: false });
        this.everyToken.add(token);
        return { status: 200, body: { data: { token, expires_at: expiresAt, jti: crypto.randomUUID() } } };
    }

    // ---- The browser-side API (intercepted by Playwright) ------------------

    /**
     * @param {{ method: string, url: string, headers: Record<string, string>, body: string | null }} request
     * @returns {{ status: number, headers: Record<string, string>, body: string }}
     */
    answerBrowser(request) {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') {
            return { status: 204, headers: CORS_HEADERS, body: '' };
        }
        const call = {
            method: request.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            body: parseJson(request.body),
            status: 0
        };
        this.calls.push(call);

        const [status, body] = this.route(call, request.headers.authorization || '');
        call.status = status;
        return {
            status,
            headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify(body)
        };
    }

    route(call, authorization) {
        const route = BROWSER_ROUTES.find((r) => r.method === call.method && r.path.test(call.path));
        if (!route) {
            this.unhandled.push(call.method + ' ' + call.path);
            return [404, problem(404, 'not-found', 'No route matches ' + call.method + ' ' + call.path)];
        }
        const grant = this.tokens.get(authorization.replace(/^Bearer /, ''));
        if (!grant || grant.revoked) {
            return [401, problem(401, 'unauthorized', 'Missing, expired or revoked token')];
        }
        if (!grant.scope.includes(route.scope)) {
            return [403, problem(403, 'insufficient-scope', 'This endpoint needs a token with the ' + route.scope + ' scope')];
        }
        return route.answer(this, call, call.path.match(route.path));
    }

    page(query) {
        const term = (query.search_term || '').toLowerCase();
        const all = [...this.contacts.values()].filter((c) => !term
            || [c.first_name, c.last_name, c.email, c.company].join(' ').toLowerCase().includes(term));
        const offset = Number(query.offset || 0);
        const limit = Number(query.limit || 25);
        return { contacts: all.slice(offset, offset + limit), total_contacts: all.length };
    }

    exactMatch(query) {
        const found = [...this.contacts.values()].filter((c) => (query.email && c.email === query.email)
            || (query.phone && c.main_phone === query.phone));
        return { contacts: found, total_contacts: found.length };
    }

    insert(body) {
        const fields = (body && body.fields) || [];
        const row = (body && body.values && body.values[0]) || [];
        const values = {};
        fields.forEach((field, i) => { values[field.type] = row[i]; });
        const existing = [...this.contacts.values()].find((c) => (values.main_phone && c.main_phone === values.main_phone)
            || (values.email && c.email === values.email));
        if (existing) {
            return { inserted: [], updated: [{ contact_id: existing.contact_id }], rejected: [] };
        }
        const contact = { contact_id: crypto.randomUUID(), has_sms_consent: false, ...values };
        this.contacts.set(contact.contact_id, contact);
        return { inserted: [{ contact_id: contact.contact_id }], updated: [], rejected: [] };
    }

    withContact(contactId, then) {
        const contact = this.contacts.get(contactId);
        return contact ? then(contact) : [404, problem(404, 'not-found', 'Contact not found')];
    }

    inStage(listId) {
        const stage = data.BOARD.stages.find((s) => s.list_id === listId);
        return stage ? stage.contacts.map((id) => this.contacts.get(id)).filter(Boolean) : [];
    }

    text(body) {
        if (this.textRefusal === 'consent_required') {
            return [403, {
                message: 'A valid consent_id is required for this embed send',
                detail: { code: 'consent_required', reason: 'no_granted_consent' }
            }];
        }
        if (this.textRefusal) {
            return [403, { message: 'Text refused', detail: { code: this.textRefusal } }];
        }
        return [200, { data: { sms_id: crypto.randomUUID(), status: 'queued', to: body && body.to } }];
    }
}

// The widget API the pages and Building Blocks call, with the site-token
// scope each route needs (the same scope the real route requires).
const UUID = '([0-9a-f-]{36})';
const BROWSER_ROUTES = [
    {
        method: 'GET', path: /^\/contact\/public\/contacts$/, scope: 'contacts',
        answer: (fake, call) => [200, { data: fake.page(call.query) }]
    },
    {
        method: 'GET', path: /^\/contact\/public\/contacts\/search$/, scope: 'contacts',
        answer: (fake, call) => [200, { data: fake.exactMatch(call.query) }]
    },
    {
        method: 'POST', path: /^\/contact\/public\/contacts$/, scope: 'contacts',
        answer: (fake, call) => [200, { data: fake.insert(call.body) }]
    },
    {
        method: 'GET', path: new RegExp('^/contact/public/contacts/' + UUID + '$'), scope: 'contacts',
        answer: (fake, call, [, id]) => fake.withContact(id, (contact) => [200, { data: { contact } }])
    },
    {
        method: 'PUT', path: new RegExp('^/contact/public/contacts/' + UUID + '$'), scope: 'contacts',
        answer: (fake, call, [, id]) => fake.withContact(id, (contact) => {
            Object.assign(contact, call.body);
            return [200, { data: { contact_id: id, updated: true } }];
        })
    },
    {
        method: 'DELETE', path: new RegExp('^/contact/public/contacts/' + UUID + '$'), scope: 'contacts',
        answer: (fake, call, [, id]) => fake.withContact(id, () => {
            fake.contacts.delete(id);
            return [200, { data: { contact_id: id, deleted: true } }];
        })
    },
    {
        method: 'POST', path: new RegExp('^/contact/public/contacts/' + UUID + '/consent$'), scope: 'contacts',
        answer: (fake, call, [, id]) => fake.withContact(id, (contact) => {
            const flag = { sms_optin: 'has_sms_consent', tcpa_optin: 'has_tcpa_consent' }[call.body && call.body.consent_type];
            if (!flag || !call.body.phone_number) {
                return [400, problem(400, 'validation-failed', 'consent_type and phone_number are required')];
            }
            contact[flag] = true;
            return [201, { data: { consent_id: crypto.randomUUID() } }];
        })
    },
    {
        method: 'GET', path: new RegExp('^/contact/public/contacts/' + UUID + '/timeline$'), scope: 'contacts',
        answer: (fake, call, [, id]) => [200, { data: { entries: fake.contacts.has(id) ? timelineFor(id) : [] } }]
    },
    {
        method: 'GET', path: /^\/boards\/public\/boards$/, scope: 'contacts',
        answer: () => [200, { data: { boards: [{ board_id: data.BOARD.board_id, name: data.BOARD.name }] } }]
    },
    {
        method: 'GET', path: new RegExp('^/boards/public/pipelines/' + UUID + '/snapshot$'), scope: 'contacts',
        answer: (fake, call, [, id]) => (id === data.BOARD.board_id
            ? [200, { data: { board_id: id, name: data.BOARD.name, stages: data.BOARD.stages.map((s) => ({ list_id: s.list_id, name: s.name })) } }]
            : [404, problem(404, 'not-found', 'Board not found')])
    },
    {
        method: 'POST', path: new RegExp('^/contact/public/contacts/' + UUID + '/lists/move$'), scope: 'contacts',
        answer: (fake, call, [, id]) => fake.withContact(id, () => {
            const stageIds = data.BOARD.stages.map((s) => s.list_id);
            const body = call.body || {};
            if (!stageIds.includes(body.from_list_id) || !stageIds.includes(body.to_list_id)) {
                return [400, problem(400, 'validation-failed', 'from_list_id and to_list_id must be lists you own')];
            }
            return [200, { data: { success: true, skipped: 0 } }];
        })
    },
    {
        method: 'GET', path: new RegExp('^/contact/public/lists/' + UUID + '/contacts$'), scope: 'contacts',
        answer: (fake, call, [, listId]) => [200, { data: { contacts: fake.inStage(listId) } }]
    },
    {
        method: 'GET', path: new RegExp('^/phone/public/sms/thread/' + UUID + '$'), scope: 'contacts',
        answer: (fake, call, [, id]) => [200, { data: { smss: id === data.CONVERSATION.contact_id ? threadFor(id) : [] } }]
    },
    {
        method: 'GET', path: /^\/phone\/embed\/inbox$/, scope: 'dialer:webrtc',
        answer: () => [200, { data: { tasks: [data.CONVERSATION] } }]
    },
    {
        method: 'POST', path: /^\/phone\/embed\/sms$/, scope: 'dialer:webrtc',
        answer: (fake, call) => fake.text(call.body)
    },
    {
        method: 'POST', path: /^\/phone\/embed\/auth$/, scope: 'dialer:webrtc',
        answer: () => [200, sipCredentials()]
    },
    {
        method: 'GET', path: /^\/campaign\/public\/campaigns$/, scope: 'campaigns',
        answer: () => [200, { data: { campaigns: data.CAMPAIGNS, total: data.CAMPAIGNS.length } }]
    },
    {
        method: 'GET', path: new RegExp('^/campaign/public/campaigns/' + UUID + '/stats$'), scope: 'campaigns',
        answer: (fake, call, [, id]) => {
            const campaign = data.CAMPAIGNS.find((c) => c.campaign_id === id);
            return campaign
                ? [200, { data: { sent: campaign.success_count + campaign.fail_count, failed: campaign.fail_count, pending: campaign.pending_count } }]
                : [404, problem(404, 'not-found', 'Campaign not found')];
        }
    },
    {
        method: 'GET', path: /^\/phone\/public\/numbers$/, scope: 'phone:hub',
        answer: () => [200, { data: { numbers: [data.OWNED_NUMBER] } }]
    },
    {
        method: 'POST', path: /^\/phone\/public\/numbers\/available$/, scope: 'phone:hub',
        answer: () => [200, { data: { numbers: [data.AVAILABLE_NUMBER] } }]
    },
    {
        method: 'POST', path: /^\/phone\/public\/numbers\/rent$/, scope: 'phone:hub',
        answer: (fake, call) => [200, { data: { phone_number: call.body && call.body.number, number_id: crypto.randomUUID() } }]
    },
    {
        method: 'GET', path: /^\/phone\/public\/(ivrs|lines)$/, scope: 'phone:hub',
        answer: () => [200, { data: { ivrs: [], lines: [] } }]
    }
];

function threadFor(contactId) {
    return [{
        sms_id: '7b3e9f2a-1c8d-4e6b-9a5f-3d2c8e1b7f60',
        contact_id: contactId,
        sms_type: 'inbound',
        sms_body: data.CONVERSATION.preview_info.task_content,
        created_at: data.CONVERSATION.preview_info.task_date
    }];
}

function timelineFor(contactId) {
    return [{
        timeline_id: '6f2a9d4c-8e1b-4c7f-9a3d-5b8e2c1f7a49',
        contact_id: contactId,
        type: 'note',
        text: 'Asked for a callback next week.',
        created_at: '2026-09-28T16:30:00.000Z',
        actor: 'Starter CRM'
    }];
}

// Where the dialer would register for calls. The test browser never connects
// to it: Playwright answers the WebSocket and stays silent.
function sipCredentials() {
    return {
        ws_uri: 'wss://sip.example.test/ws',
        username: 'e2e-' + crypto.randomUUID(),
        password: crypto.randomBytes(12).toString('hex'),
        realm: 'sip.example.test',
        expires_at: Date.now() + 3600 * 1000
    };
}

/** Shaped like a signed JWT so the widgets can read its claims; nobody checks the signature here. */
export function fakeJwt(claims) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(claims) + '.' + crypto.randomBytes(32).toString('base64url');
}

function problem(status, slug, detail) {
    return {
        type: 'https://api-v2.dropcowboy.com/errors/' + slug,
        title: slug,
        status,
        detail,
        request_id: crypto.randomUUID()
    };
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => resolve(body));
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
