import express from 'express';
import { requireLogin, requireUser } from './auth.js';
import { devSessionRoute } from './dev-session.js';
import { errorHandler, notFound } from './errors.js';
import { createEventStore, eventsRoute } from './events.js';
import { createLogger } from './log.js';
import { readinessRoute } from './readiness.js';
import { staticRoutes } from './static.js';
import { tokenRoute } from './token.js';
import { webhookRoute } from './webhooks.js';

// Builds the app without listening, so tests can drive it. `deps` lets tests
// swap fetch, the logger and the event store.
export function createApp(config, deps = {}) {
    const fetchImpl = deps.fetch || globalThis.fetch;
    const log = deps.log || createLogger(config);
    const store = deps.store || createEventStore();
    const user = requireUser(config);

    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        next();
    });

    app.get('/healthz', (req, res) => res.json({ ok: true }));
    app.get('/api/config', (req, res) => res.json(publicConfig(config)));

    // server mode mints for your user with your API key; login mode mints
    // for whoever signed in with Drop Cowboy, using their access token.
    if (config.mode === 'server' || config.mode === 'login') {
        const caller = config.mode === 'login' ? requireLogin : user;
        app.post('/api/dropcowboy/token', caller, express.json({ limit: '1mb' }), tokenRoute(config, fetchImpl));
        app.get('/api/dropcowboy/readiness', caller, readinessRoute(config, fetchImpl));
    }

    if (config.mode === 'mcp-session') {
        app.get('/__dev/session', devSessionRoute(config));
    }

    // express.raw keeps req.body as the exact bytes Drop Cowboy signed. No
    // JSON parser may run before this route.
    app.post('/webhooks/dropcowboy', express.raw({ type: () => true, limit: '1mb' }), webhookRoute(config, store, log));
    app.get('/api/events', user, eventsRoute(store));

    app.use(['/api', '/__dev', '/webhooks', '/healthz'], notFound);
    app.use(staticRoutes(config));
    app.use(notFound);
    app.use(errorHandler(log));

    return app;
}

// Everything here reaches the browser. Never add a secret.
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
