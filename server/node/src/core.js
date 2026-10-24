/**
 * The web-standard core: every route of the Starter CRM server as one
 * function, `handle(request) -> Promise<Response>`.
 *
 * Where it sits: an adapter (Express in `adapters/express.js`; Hono, Next.js
 * and Netlify Functions later) turns its framework's request into a web
 * `Request`, calls `core.handle()`, and writes the `Response` back. Nothing in
 * this file or in the route modules it wires imports a web framework, so a new
 * framework needs only a new adapter, never new routes.
 *
 * CONTRACT.md: every route in "Routes", plus "Error envelope".
 * What a customer changes: requireUser() in auth.js, and the route table below
 * when adding a route. Keep every handler awaited: nothing may run after the
 * response is returned, because serverless hosts freeze the process then.
 */

import { requireLogin, requireUser } from './auth.js';
import { devSessionRoute } from './dev-session.js';
import { HttpError, notFound, toErrorResponse } from './errors.js';
import { eventsRoute } from './events.js';
import { createHooks } from './hooks.js';
import { clientIp, jsonResponse } from './http.js';
import { createLifecycle } from './lifecycle.js';
import { createLogger } from './log.js';
import { matchPath } from './modules.js';
import * as devIdentity from './providers/identity/dev.js';
import * as memoryLimiter from './providers/ratelimit/memory.js';
import * as offLimiter from './providers/ratelimit/off.js';
import { readinessRoute } from './readiness.js';
import { pickRequestId, runWithRequestId } from './request-context.js';
import { applyCors, applySecurityHeaders, preflight } from './security.js';
import { defaultRuntime } from './runtime.js';
import { RESERVED_PREFIXES, isUnder, staticRoutes } from './static.js';
import { tokenRoute } from './token.js';
import { webhookRoute, webhookStatusRoute } from './webhooks.js';

/** Rate-limit window: every limit in CONTRACT.md "Rate limits" is per minute. */
const WINDOW_SECONDS = 60;

/** Token route requests per client IP per minute, counted before authentication so a flood of bad callers is still stopped. */
const TOKEN_PER_IP_PER_MINUTE = 300;

/** Dev session reads per client IP per minute. */
const DEV_SESSION_PER_IP_PER_MINUTE = 10;

/**
 * Everything here reaches the browser. Never add a secret.
 *
 * @param {object} config The loaded server config; only public fields are read.
 * @returns {object} The JSON body of GET /api/config.
 */
export function publicConfig(config) {
    return {
        auth_mode: config.mode,
        site_id: config.siteId,
        api_base: config.apiBase,
        cdn_version: config.cdnVersion,
        auth0: config.mode === 'login'
            ? { domain: config.auth0.domain, client_id: config.auth0.clientId, audience: config.auth0.audience }
            : null
    };
}

/**
 * Builds the core without listening on anything, so tests and adapters can
 * drive it.
 *
 * @param {object} config From loadConfig().
 * @param {{ fetch?: typeof fetch, log?: object, runtime?: object, lifecycle?: object, identity?: object,
 *   ratelimit?: object, observer?: object, secrets?: object }} [deps]
 *   What boot created (bootstrap.js): the identity, rate limiter, observer, secrets
 *   runtime and event runtime. Tests may pass doubles: `fetch` replaces the upstream HTTP client,
 *   `log` the logger, `runtime` the event runtime and `lifecycle` the drain controller. Anything
 *   omitted gets the built-in default for `config`.
 * @returns {{ handle: (request: Request, info?: { remoteAddress?: string, rawPath?: string }) => Promise<Response>,
 *   lifecycle: object, runtime: object, store: object, log: object }} The core: `handle` answers
 *   one request, and the rest are shared with the adapter for shutdown.
 */
export function createCore(config, deps = {}) {
    const fetchImpl = deps.fetch || globalThis.fetch;
    const log = deps.log || createLogger(config);
    // Identity is only used in server mode; the other modes get the always-passing placeholder.
    const identity = deps.identity || devIdentity.create({ config });
    const limiter = deps.ratelimit || (config.rateLimit === 'off' ? offLimiter.create() : memoryLimiter.create());
    const hooks = createHooks(deps.observer || null, log);
    const secrets = deps.secrets || null;
    const runtime = deps.runtime || defaultRuntime(config, log);
    const store = runtime.store;
    const lifecycle = deps.lifecycle || createLifecycle({
        store: { ready: () => runtime.ready() },
        shutdownGraceSeconds: config.shutdownGraceSeconds ?? 10
    });

    const user = requireUser(identity);
    const routes = new Map();
    const add = (method, routePath, ...steps) => routes.set(method + ' ' + routePath, steps);

    // Liveness: cheap, always 200 while the process is up.
    add('GET', '/healthz', async () => jsonResponse(200, { ok: true }));

    // Readiness: 503 while draining or when the store is not ready, so load
    // balancers stop sending traffic before shutdown. Distinct from
    // GET /api/dropcowboy/readiness (the account checklist).
    add('GET', '/readyz', async () => {
        const result = await lifecycle.checkReady();
        if (!result.ok) {
            return jsonResponse(503, { ok: false, reason: result.reason || 'not_ready' });
        }
        return jsonResponse(200, { ok: true });
    });

    add('GET', '/api/config', async () => jsonResponse(200, publicConfig(config)));

    /**
     * Counts one hit against a limit and throws 429 when it is over.
     *
     * @param {string} bucket Which limit, such as `token-ip`.
     * @param {string} key Who it is counted for: an IP, a user id or a token hash.
     * @param {number} max Hits allowed per window.
     * @returns {Promise<void>}
     * @throws {HttpError} 429 `rate_limited` with `Retry-After`.
     */
    async function limit(bucket, key, max) {
        const result = await limiter.hit(bucket + ':' + key, max, WINDOW_SECONDS);
        if (!result.allowed) {
            const wait = Math.max(1, Math.ceil(result.retryAfterSeconds ?? 1));
            throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in ' + wait + ' seconds.', { 'retry-after': String(wait) });
        }
    }
    const perIp = (bucket, max) => async (ctx) => limit(bucket, ctx.clientIp, max);

    // server mode mints for your user with your API key; login mode mints
    // for whoever signed in with Drop Cowboy, using their access token.
    if (config.mode === 'server' || config.mode === 'login') {
        const caller = config.mode === 'login' ? requireLogin : user;
        add('POST', '/api/dropcowboy/token', perIp('token-ip', TOKEN_PER_IP_PER_MINUTE), caller, tokenRoute(config, fetchImpl));
        add('GET', '/api/dropcowboy/readiness', caller, readinessRoute(config, fetchImpl));
    }

    // The session endpoint never answers 401: it is how a page learns whether to show a sign-in screen.
    if (config.mode === 'server') {
        add('GET', '/api/auth/session', async (ctx) => {
            let found = null;
            try {
                found = await identity.authenticate(ctx.request);
            } catch (err) {
                if (!(err instanceof HttpError) || err.status !== 401) throw err;
            }
            let shown = null;
            if (found) {
                shown = { id: found.id };
                if (found.email) shown.email = found.email;
                if (found.name) shown.name = found.name;
            }
            return jsonResponse(200, { identity: config.identityKind, signed_in: Boolean(found), user: shown }, { 'cache-control': 'no-store' });
        });
        for (const route of typeof identity.routes === 'function' ? identity.routes() : []) {
            add(route.method, route.path, route.handler);
        }
    }

    if (config.mode === 'mcp-session') {
        add('GET', '/__dev/session', perIp('dev-session', DEV_SESSION_PER_IP_PER_MINUTE), devSessionRoute(config));
    }

    // The webhook route reads the raw bytes itself. No JSON parser may run
    // before it: the signature covers the exact bytes Drop Cowboy sent.
    add('POST', '/webhooks/dropcowboy', webhookRoute(config, { store, dispatcher: runtime.dispatcher }));
    add('GET', '/api/webhooks/status', user, webhookStatusRoute(config, { store }));
    // A queue-backed webhook mode adds the route its queue calls back (for example QStash's /internal/webhook-jobs).
    // Each such route checks its caller itself, so none of them takes the `user` step.
    for (const route of typeof runtime.dispatcher.routes === 'function' ? runtime.dispatcher.routes() : []) {
        add(route.method, route.path, route.handler);
    }
    add('GET', '/api/events', user, eventsRoute({
        store,
        fanout: runtime.fanout,
        maxStreamSeconds: config.events.maxStreamSeconds,
        keepaliveSeconds: config.events.keepaliveSeconds
    }, lifecycle));

    // Modules (src/modules/) serve under /api/modules/<id>/ and need a signed-in user, so only server mode has them.
    // A route with a `:name` part cannot be looked up by key, so those wait in a list that is searched after the table.
    const paramRoutes = [];
    for (const route of config.mode === 'server' && runtime.modules ? runtime.modules.routes : []) {
        if (route.segments.some((part) => part.startsWith(':'))) {
            paramRoutes.push({ method: route.method, segments: route.segments, steps: [user, route.step] });
        } else {
            add(route.method, route.segments.join('/'), user, route.step);
        }
    }

    const serveStatic = staticRoutes(config);

    /**
     * Answers one request. Never throws: every failure becomes the error envelope.
     *
     * @param {Request} request The incoming request.
     * @param {{ remoteAddress?: string, rawPath?: string }} [info] What the host
     *   knows that the request does not: the TCP peer address, and the request
     *   path exactly as sent (a `Request`'s URL has `..` segments already resolved).
     * @returns {Promise<Response>} The response.
     */
    async function handle(request, info = {}) {
        const requestId = pickRequestId(request.headers.get('x-request-id'));
        return runWithRequestId(requestId, () => handleRequest(request, info, requestId));
    }

    /**
     * The body of handle(), running inside the request-id scope.
     *
     * @param {Request} request The incoming request.
     * @param {{ remoteAddress?: string, rawPath?: string }} info Host-provided details.
     * @param {string} requestId The id chosen for this request.
     * @returns {Promise<Response>} The response.
     */
    async function handleRequest(request, info, requestId) {
        const started = performance.now();
        const method = request.method.toUpperCase();
        const urlPath = info.rawPath !== undefined ? info.rawPath : new URL(request.url).pathname;
        const requestLog = typeof log.child === 'function' ? log.child({ request_id: requestId }) : log;
        const ctx = {
            request,
            method,
            path: urlPath,
            config,
            log: requestLog,
            hooks,
            requestId,
            limit,
            remoteAddress: info.remoteAddress || null,
            clientIp: clientIp(request.headers, info.remoteAddress, config.trustProxy ?? 0),
            user: null,
            accessToken: null
        };
        let response;
        try {
            // Awaited here, in the request, so it works on hosts that freeze the process between requests.
            if (secrets) await secrets.refreshIfDue();
            await hooks.onRequest({ request_id: requestId, method, path: urlPath, client_ip: ctx.clientIp });
            response = await dispatch(ctx);
        } catch (err) {
            response = await toErrorResponse(err, ctx, requestLog);
        }
        applySecurityHeaders(response, config);
        applyCors(request, response, config);
        response.headers.set('x-request-id', requestId);

        const durationMs = Math.round(performance.now() - started);
        if (config.logRequests && typeof requestLog.access === 'function') {
            await requestLog.access({ method, path: urlPath, status: response.status, duration_ms: durationMs });
        }
        await hooks.onResponse({ request_id: requestId, method, path: urlPath, status: response.status, duration_ms: durationMs });
        return response;
    }

    /**
     * Finds a module route with `:name` parts that matches the request, and records the parts as `ctx.params`.
     *
     * @param {string} method The method, with HEAD already treated as GET.
     * @param {object} ctx The request context.
     * @returns {Function[]|null} The route's steps, or null when none matches.
     */
    function matchParamRoute(method, ctx) {
        for (const route of paramRoutes) {
            if (route.method !== method) continue;
            const params = matchPath(route.segments, ctx.path);
            if (params) {
                ctx.params = params;
                return route.steps;
            }
        }
        return null;
    }

    /**
     * Picks the route, or the static files, or 404.
     *
     * @param {object} ctx The request context.
     * @returns {Promise<Response>} The response.
     */
    async function dispatch(ctx) {
        // OPTIONS is only ever a CORS preflight, and only when CORS is on.
        if (ctx.method === 'OPTIONS') {
            return preflight(ctx) || notFound(ctx);
        }
        // HEAD runs the GET route; the adapter drops the body.
        const method = ctx.method === 'HEAD' ? 'GET' : ctx.method;
        const steps = routes.get(method + ' ' + ctx.path) || matchParamRoute(method, ctx);
        if (steps) {
            for (const step of steps) {
                const result = await step(ctx);
                if (result instanceof Response) {
                    return result;
                }
            }
            throw new HttpError(500, 'internal_error', 'A route finished without a response.');
        }
        if (isUnder(ctx.path, RESERVED_PREFIXES)) {
            return notFound(ctx);
        }
        return serveStatic(ctx);
    }

    return { handle, lifecycle, runtime, store, log };
}
