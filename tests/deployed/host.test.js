// Host checks for a deployed Starter CRM: what a host in front of the server can
// break that the conformance suite, which talks to the server directly, cannot
// see. HTTPS, the response headers that survive the proxy, the compression and
// caching of the front-end, a webhook acknowledged in time, and a live event
// stream that outlives the host's idle limit.
//
//   npm run test:deployed -- --url https://crm.example.com --passcode ... --webhook-secret ...
//
// Where it sits: scripts/test-deployed.mjs sets the environment and runs this
// file, then the browser spec. Run it by hand with
// STARTER_CRM_DEPLOYED_URL set. The settings come from the environment:
//
//   STARTER_CRM_DEPLOYED_URL             required, the address of the deployed server.
//   STARTER_CRM_DEPLOYED_PASSCODE        the passcode, for the signed-in checks (the passcode identity).
//   STARTER_CRM_DEPLOYED_WEBHOOK_SECRET  a signing secret the host accepts, for the webhook and stream checks.
//   STARTER_CRM_DEPLOYED_HOLD_SECONDS    how long the event stream is held open (default 75).
//   STARTER_CRM_DEPLOYED_REQUIRE_ALL     "1" turns a check skipped for a missing setting into a failure.
//
// What it sends: reads, a sign-in, and one fictional webhook event about a made-up
// contact (a 555 test number). It never calls Drop Cowboy, sends nothing to a phone
// and writes nothing to your account. The event does appear in the host's activity
// feed, so point it at a host you do not mind that on.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';

const URL_ENV = (process.env.STARTER_CRM_DEPLOYED_URL || '').replace(/\/+$/, '');
if (!URL_ENV) throw new Error('Set STARTER_CRM_DEPLOYED_URL to the deployed server, for example https://crm.example.com');
const BASE = new URL(URL_ENV);
const PASSCODE = process.env.STARTER_CRM_DEPLOYED_PASSCODE || '';
const WEBHOOK_SECRET = process.env.STARTER_CRM_DEPLOYED_WEBHOOK_SECRET || '';
const HOLD_SECONDS = Number(process.env.STARTER_CRM_DEPLOYED_HOLD_SECONDS || 75);
const REQUIRE_ALL = process.env.STARTER_CRM_DEPLOYED_REQUIRE_ALL === '1';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'].includes(BASE.hostname);
const HTTPS = BASE.protocol === 'https:';

/** Skips a check for a missing setting, or fails it when every check was demanded. */
function needs(t, present, what) {
    if (present) return true;
    assert.ok(!REQUIRE_ALL, what + ' required (STARTER_CRM_DEPLOYED_REQUIRE_ALL=1)');
    t.skip(what + ' not given');
    return false;
}

/** A GET that never follows a redirect, so a redirect to http shows up as one. */
function get(route, headers = {}) {
    return fetch(BASE.origin + route, { headers: { connection: 'close', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
}

let signedIn = null;

/**
 * Signs in with the passcode, as the page does. The sign-in route allows 10 attempts a minute per
 * address, so the answer is kept for the whole run, and one `429` is waited out.
 *
 * @returns {Promise<{ cookie: string, setCookie: string }>} The cookie to send, and the header as sent.
 */
function signIn() {
    signedIn ||= attemptSignIn(true);
    return signedIn;
}

async function attemptSignIn(mayWait) {
    const response = await fetch(BASE.origin + '/api/auth/passcode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE.origin },
        body: JSON.stringify({ passcode: PASSCODE }),
        signal: AbortSignal.timeout(15000)
    });
    if (response.status === 429 && mayWait) {
        const seconds = Math.min(Number(response.headers.get('retry-after')) || 60, 65);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return attemptSignIn(false);
    }
    assert.equal(response.status, 200, 'sign-in answered HTTP ' + response.status);
    const setCookie = response.headers.get('set-cookie') || '';
    return { cookie: setCookie.split(';')[0], setCookie };
}

/**
 * A GET that returns the bytes as they came over the wire. `fetch` decodes gzip itself, which would hide
 * whether the host compressed anything.
 *
 * @param {string} route The path.
 * @param {Record<string, string>} headers Request headers.
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>} The raw response.
 */
function getRaw(route, headers) {
    const client = HTTPS ? https : http;
    return new Promise((resolve, reject) => {
        const req = client.get(BASE.origin + route, { headers: { connection: 'close', ...headers }, timeout: 15000 }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
    });
}

/**
 * Posts one signed fictional event, the way Drop Cowboy does.
 *
 * @param {string} secret The signing secret.
 * @param {{ eventId?: string, timestamp?: number, marker?: string }} [options] Overrides for a replay or a stale event.
 * @returns {Promise<{ status: number, body: object, ms: number, eventId: string, marker: string }>} The answer and how long it took.
 */
async function deliver(secret, options = {}) {
    const eventId = options.eventId || crypto.randomUUID();
    const marker = options.marker || 'deployed-check-' + crypto.randomUUID().slice(0, 8);
    const timestamp = String(options.timestamp || Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
        event_id: eventId,
        event: 'contact.msg.received',
        event_at: new Date().toISOString(),
        data: { contact_id: crypto.randomUUID(), from: '+15550100001', body: marker }
    });
    const signature = crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
    const started = performance.now();
    const response = await fetch(BASE.origin + '/webhooks/dropcowboy', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            connection: 'close',
            'x-signature': 'sha256=' + signature,
            'x-signature-version': 'v1',
            'x-timestamp': timestamp,
            'x-event-id': eventId,
            'x-attempt': '1'
        },
        body,
        signal: AbortSignal.timeout(15000)
    });
    const ms = performance.now() - started;
    return { status: response.status, body: await response.json().catch(() => ({})), ms, eventId, marker };
}

describe('deployed host ' + BASE.origin, () => {
    it('is served over HTTPS, and plain HTTP does not serve the app', async (t) => {
        if (!HTTPS) {
            assert.ok(LOOPBACK, 'a deployed host must use https, got ' + BASE.protocol);
            return t.skip('a loopback address is checked over http; HTTPS applies to a real host');
        }
        const response = await get('/healthz');
        assert.equal(response.status, 200);
        // Hosts redirect http to https, or refuse it. What matters is that it never answers the app in clear text.
        try {
            const clear = await fetch('http://' + BASE.host + '/healthz', { redirect: 'manual', signal: AbortSignal.timeout(8000) });
            const location = clear.headers.get('location') || '';
            assert.ok(clear.status >= 300 && clear.status < 400 && location.startsWith('https://'),
                'http answered HTTP ' + clear.status + ' instead of redirecting to https');
        } catch (err) {
            if (err.name === 'AssertionError') throw err;
        }
    });

    it('answers /healthz and /readyz', async () => {
        const health = await get('/healthz');
        assert.equal(health.status, 200);
        const ready = await get('/readyz');
        assert.equal(ready.status, 200);
        assert.equal((await ready.json()).ok, true);
    });

    it('sends the security headers, with the host in the way', async () => {
        const response = await get('/');
        assert.equal(response.status, 200);
        const h = response.headers;
        assert.equal(h.get('x-content-type-options'), 'nosniff');
        assert.equal(h.get('referrer-policy'), 'no-referrer');
        assert.equal(h.get('x-frame-options'), 'DENY');
        const csp = h.get('content-security-policy') || h.get('content-security-policy-report-only') || '';
        assert.match(csp, /frame-ancestors 'none'/, 'a content security policy with frame-ancestors is missing');
        assert.match(csp, /object-src 'none'/);
        if (HTTPS) {
            assert.match(h.get('strict-transport-security') || '', /max-age=\d{7,}/, 'HSTS is missing: is DC_ENV=production?');
        }
        // A page Netlify's CDN serves never reaches the server, so the CDN's own request id stands in for the server's.
        assert.ok(h.get('x-request-id') || h.get('x-nf-request-id'), 'X-Request-Id is missing');
    });

    it('publishes only public configuration', async () => {
        const text = await (await get('/api/config')).text();
        const config = JSON.parse(text);
        assert.match(config.site_id || '', /^[0-9a-f-]{36}$/i, 'site_id should be a UUID');
        assert.ok(['server', 'login'].includes(config.auth_mode), 'auth_mode ' + config.auth_mode + ' is not for production');
        assert.doesNotMatch(text, /secret|passcode|password|api_key/i, 'the public config mentions a secret');
    });

    it('serves the front-end compressed, and revalidates instead of re-sending', async (t) => {
        const first = await get('/', { 'accept-encoding': 'gzip' });
        assert.equal(first.status, 200);
        assert.equal(first.headers.get('cache-control'), 'no-cache', 'the page must be revalidated on each load');
        const etag = first.headers.get('etag');
        assert.ok(etag, 'the page has no ETag');

        let second = await get('/', { 'if-none-match': etag, 'accept-encoding': 'gzip' });
        if (second.status === 200 && first.headers.get('x-nf-request-id') && /-df"$/.test(etag)) {
            // Netlify's CDN tags a compressed response "<tag>-df" but matches only "<tag>", so a browser downloads the
            // page again on every load. Nothing the app sends changes that; check revalidation works for the tag it matches.
            t.diagnostic('Netlify does not revalidate its compressed ETag ' + etag + '; checking the uncompressed one');
            const plain = await get('/', { 'accept-encoding': 'identity' });
            second = await get('/', { 'if-none-match': plain.headers.get('etag'), 'accept-encoding': 'identity' });
        }
        assert.equal(second.status, 304, 'a matching ETag should answer 304');

        // A module of 1 KB or more is gzipped, wherever a proxy sits.
        const module = await getRaw('/shared/server-api.js', { 'accept-encoding': 'gzip' });
        assert.equal(module.status, 200);
        assert.equal(module.headers['content-encoding'], 'gzip', 'a 1 KB or larger module should be gzipped; a proxy may be stripping it');
        assert.ok(zlib.gunzipSync(module.body).length > module.body.length, 'gzip made it larger');
        const vary = module.headers.vary || '';
        if (!/accept-encoding/i.test(vary) && module.headers['x-nf-request-id'] && /fwd-status=304/.test(module.headers['cache-status'] || '')) {
            // Netlify's CDN drops Accept-Encoding from Vary on a response it revalidated against its own storage. Its
            // cache still keys on the encoding, so check that instead.
            t.diagnostic('Netlify sent Vary: ' + vary + ' on a revalidated response; checking it keeps the encodings apart');
            const plain = await getRaw('/shared/server-api.js', { 'accept-encoding': 'identity' });
            assert.equal(plain.status, 200);
            assert.equal(plain.headers['content-encoding'], undefined, 'a client that refused gzip was sent gzip');
        } else {
            assert.match(vary, /accept-encoding/i);
        }
    });

    it('serves a hashed React asset as immutable', async (t) => {
        const page = await (await get('/react/')).text();
        const asset = page.match(/\/react\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.js/);
        if (!asset) return t.skip('no React build is served here');
        const response = await get(asset[0]);
        assert.equal(response.status, 200);
        // Netlify's CDN drops the optional spaces after the commas.
        assert.equal((response.headers.get('cache-control') || '').replace(/\s*,\s*/g, ', '), 'public, max-age=31536000, immutable');
    });

    it('refuses the event stream and the API to a visitor who is not signed in', async () => {
        for (const route of ['/api/events', '/api/dropcowboy/readiness']) {
            const response = await get(route, { accept: 'application/json' });
            assert.ok([401, 403].includes(response.status), route + ' answered HTTP ' + response.status + ' to a stranger');
            await response.body?.cancel();
        }
    });

    it('rejects an unsigned webhook quickly', async () => {
        const started = performance.now();
        const response = await fetch(BASE.origin + '/webhooks/dropcowboy', {
            method: 'POST',
            headers: { 'content-type': 'application/json', connection: 'close' },
            body: '{}',
            signal: AbortSignal.timeout(15000)
        });
        assert.ok([401, 503].includes(response.status), 'answered HTTP ' + response.status);
        assert.ok(performance.now() - started < 1000, 'answered too slowly');
    });

    it('acknowledges a signed webhook in under a second, and a replay as a duplicate', async (t) => {
        if (!needs(t, WEBHOOK_SECRET, 'STARTER_CRM_DEPLOYED_WEBHOOK_SECRET')) return;
        const first = await deliver(WEBHOOK_SECRET);
        assert.equal(first.status, 200, 'a signed event answered HTTP ' + first.status
            + (first.status === 401 ? ' (wrong secret, or the host clock is more than 5 minutes off)' : ''));
        if (first.ms >= 1000) {
            // A function that has gone cold boots on this request, and a hosted queue's function may too. That is still
            // inside Drop Cowboy's window when it stays under 4 s, provided the same request is fast once warm.
            assert.ok(first.ms < 4000, 'acknowledged in ' + Math.round(first.ms) + ' ms; Drop Cowboy waits 5 s');
            const warm = await deliver(WEBHOOK_SECRET);
            assert.equal(warm.status, 200);
            assert.ok(warm.ms < 1000, 'acknowledged in ' + Math.round(first.ms) + ' ms, then ' + Math.round(warm.ms)
                + ' ms warm; Drop Cowboy waits 5 s, plan for under 1 s');
            t.diagnostic('first acknowledgement ' + Math.round(first.ms) + ' ms (a cold start), then ' + Math.round(warm.ms) + ' ms');
        }
        const replay = await deliver(WEBHOOK_SECRET, { eventId: first.eventId });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.duplicate, true, 'a repeated event id should be acknowledged as a duplicate');
        const stale = await deliver(WEBHOOK_SECRET, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
        assert.equal(stale.status, 401, 'an event signed an hour ago should be refused');
    });

    it('sets a Secure, HttpOnly session cookie on sign-in', async (t) => {
        if (!needs(t, PASSCODE, 'STARTER_CRM_DEPLOYED_PASSCODE')) return;
        const { setCookie } = await signIn();
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /SameSite=Lax/i);
        if (HTTPS) assert.match(setCookie, /;\s*Secure/i, 'the session cookie is not Secure');
        assert.ok(!setCookie.includes(PASSCODE), 'the cookie holds the passcode');
    });

    it('keeps the event stream open past the host\'s idle limit and delivers an event at the end', async (t) => {
        if (!needs(t, PASSCODE && WEBHOOK_SECRET, 'the passcode and the webhook secret')) return;
        const { cookie } = await signIn();
        const abort = new AbortController();
        const response = await fetch(BASE.origin + '/api/events', {
            headers: { cookie, accept: 'text/event-stream' },
            signal: abort.signal
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

        const decoder = new TextDecoder();
        let text = '';
        let closedAt = null;
        const reader = (async () => {
            try {
                for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true });
                closedAt = Date.now();
            } catch (err) {
                if (err.name !== 'AbortError') closedAt = Date.now();
            }
        })();

        const started = Date.now();
        // The marker is one this run made up, so an event from earlier cannot satisfy the check.
        const marker = 'deployed-hold-' + crypto.randomUUID().slice(0, 8);
        await new Promise((resolve) => setTimeout(resolve, HOLD_SECONDS * 1000));
        assert.equal(closedAt, null, 'the host closed the event stream after ' + Math.round(((closedAt || Date.now()) - started) / 1000)
            + ' s; a load balancer or proxy idle limit is shorter than ' + HOLD_SECONDS + ' s');
        assert.ok(text.includes('event: replayed'), 'the stream never sent its replay marker');
        assert.ok(/: keepalive/.test(text) || HOLD_SECONDS < 30, 'no keepalive arrived while the stream was idle');

        const sent = await deliver(WEBHOOK_SECRET, { marker });
        assert.equal(sent.status, 200);
        for (let i = 0; i < 40 && !text.includes(marker); i++) await new Promise((resolve) => setTimeout(resolve, 250));
        abort.abort();
        await reader;
        assert.ok(text.includes(marker), 'an event sent after ' + HOLD_SECONDS + ' s did not reach the open stream');
    });
});
