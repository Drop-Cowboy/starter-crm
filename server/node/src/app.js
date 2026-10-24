/**
 * Express application factory for the Starter CRM Node server.
 *
 * Where it sits: browser and Drop Cowboy hit these routes; index.js calls
 * createApp(config).listen(...). Tests call createApp() without listening.
 * The routes themselves live in core.js; this file only mounts them on Express.
 *
 * CONTRACT.md: every route in "Routes".
 * Customers replace requireUser() and add module routes; keep publicConfig()
 * free of secrets.
 */

import { expressAdapter } from './adapters/express.js';
import { createCore, publicConfig } from './core.js';

export { publicConfig };

/**
 * Builds the app without listening, so tests can drive it. `deps` lets tests
 * swap fetch, the logger and the event runtime.
 *
 * @param {object} config From loadConfig().
 * @param {{ fetch?: typeof fetch, log?: object, runtime?: object, lifecycle?: object, identity?: object,
 *   ratelimit?: object, observer?: object, secrets?: object }} [deps]
 *   What boot created, or test doubles: `fetch` replaces the upstream HTTP client, `log` the
 *   logger, `runtime` the event runtime, `lifecycle` the drain controller, and `identity`,
 *   `ratelimit`, `observer` and `secrets` the providers.
 * @returns {import('express').Express} The configured, not yet listening, app.
 */
export function createApp(config, deps = {}) {
    return expressAdapter(createCore(config, deps), config);
}
