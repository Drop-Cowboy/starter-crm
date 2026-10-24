/**
 * Your modules: server code for the things your CRM tracks that Drop Cowboy does not.
 *
 * Where it sits: every folder under `src/modules/` that has an `index.js` is a module. Boot
 * (bootstrap.js) loads them all with `loadModules()`, core.js registers each one's routes under
 * `/api/modules/<id>/` (from `createModules()`), and the processor (processor.js) hands every
 * finished webhook event to `runEventHooks()`. The built-in example is `modules/deals/`;
 * `npm run new:module -- tickets` copies it. Nothing in core names a module, so adding or
 * removing a folder never touches core and upstream upgrades stay mergeable.
 *
 * A module is the default export of its `index.js`:
 *
 * ```js
 * export default {
 *     id: 'deals',                       // the folder name, lowercase letters, digits and dashes
 *     routes(router) {                   // optional: add routes under /api/modules/deals
 *         router.get('/', async (ctx) => ({ deals: await ctx.data.collection('deals').list() }));
 *         router.post('/', { body: schemas.create }, async (ctx) => ctx.reply(201, { ... }));
 *         router.delete('/:id', async (ctx) => { ... ctx.params.id ... });
 *     },
 *     onEvent: {                         // optional: run when Drop Cowboy sends an event
 *         'contact.deleted': async (event, ctx) => { ... }
 *     }
 * };
 * ```
 *
 * A route handler receives `ctx`: `user` (who is signed in), `data` (the data API, already limited to
 * that user, so there is no way to read another user's documents), `log`, `dropcowboy(request)` (a
 * call to the Drop Cowboy API with this server's key), `signal` (aborted when the caller goes away),
 * `params` (the `:name` parts of the path), `query` (the query string; the first of a repeated name),
 * `body` (the validated JSON body, when the route names a `body` schema) and `reply(status, body)`.
 * Returning a value answers 200 with it as JSON; `ctx.reply(201, value)` picks another status; throw an
 * `HttpError` for an error envelope. An event handler gets the event and a `ctx` with `data` over
 * EVERY owner (`data.system()`), `log`, `dropcowboy`, `signal`, `eventId` and `attempt`. Delivery is
 * at-least-once, so an event handler must be idempotent.
 *
 * Routes need a signed-in user, so modules are mounted in `DC_AUTH_MODE=server` only. Everything a route
 * does is awaited before the response is returned: nothing may run after it, because serverless hosts
 * freeze the process then.
 *
 * CONTRACT.md: "Modules".
 * What a customer changes: nothing here; add a folder under `src/modules/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpError } from './errors.js';
import { jsonResponse, readJsonBody } from './http.js';
import { callDropCowboy } from './upstream.js';
import { assertSupported, checkBody } from './validate.js';

/** Where the modules live: a folder per module next to this file. */
const MODULES_DIR = path.join(import.meta.dirname, 'modules');

/** What a module id may look like. It becomes part of every URL the module serves. */
const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** What a route path may look like: `/`, or segments that are lowercase words or `:name` parameters. */
const ROUTE_PATH = /^\/(?:(?:[a-z0-9_-]+|:[a-z][a-z0-9_]*)(?:\/(?:[a-z0-9_-]+|:[a-z][a-z0-9_]*))*)?$/;

/** The methods a module route may use. Creates and updates are POST and deletes are DELETE, as everywhere in this server. */
const METHODS = Object.freeze({ get: 'GET', post: 'POST', delete: 'DELETE' });

/** Requests one user may make to module routes per minute. */
const USER_PER_MINUTE = 600;

/**
 * The answer a route chose with `ctx.reply()`.
 */
class Reply {
    /**
     * Creates the answer.
     *
     * @param {number} status The HTTP status.
     * @param {unknown} body Anything `JSON.stringify` accepts.
     */
    constructor(status, body) {
        this.status = status;
        this.body = body;
    }
}

/**
 * Finds and loads every module under `src/modules/`.
 *
 * @param {string} [dir] The folder to scan; tests pass their own.
 * @returns {Promise<{ modules: object[], problem: string|null }>} The modules in folder order, or a description of what is wrong with one.
 */
export async function loadModules(dir = MODULES_DIR) {
    if (!fs.existsSync(dir)) return { modules: [], problem: null };
    const modules = [];
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const folder of names) {
        const file = path.join(dir, folder, 'index.js');
        if (!fs.existsSync(file)) continue;
        let loaded;
        try {
            // A module is a folder of your own code, discovered at boot, so its path is only known at run time.
            loaded = await import(pathToFileURL(file).href);
        } catch (err) {
            return { modules: [], problem: 'module "' + folder + '" could not be loaded: ' + (err && err.message ? err.message : 'unknown error') };
        }
        const wrong = shapeProblem(loaded.default, folder);
        if (wrong) return { modules: [], problem: 'module "' + folder + '" ' + wrong };
        modules.push(loaded.default);
    }
    return { modules, problem: null };
}

/**
 * Checks a module has the documented shape.
 *
 * @param {unknown} mod What the module's `index.js` exports as default.
 * @param {string} folder The folder it was found in; the id must match.
 * @returns {string|null} What is wrong, or null when it is fine.
 */
export function shapeProblem(mod, folder) {
    if (!mod || typeof mod !== 'object') return 'must export default an object with an id';
    if (typeof mod.id !== 'string' || !MODULE_ID.test(mod.id)) return 'needs an `id` of lowercase letters, digits and dashes (got ' + JSON.stringify(mod.id) + ')';
    if (mod.id !== folder) return 'has id "' + mod.id + '", which must match its folder name';
    if (mod.routes !== undefined && typeof mod.routes !== 'function') return '`routes` must be a function taking the router';
    if (mod.onEvent !== undefined) {
        if (!mod.onEvent || typeof mod.onEvent !== 'object') return '`onEvent` must be an object mapping event names to functions';
        for (const [key, fn] of Object.entries(mod.onEvent)) {
            if (typeof fn !== 'function') return 'event handler "' + key + '" is not a function';
        }
    }
    return null;
}

/**
 * Asks a module for its routes.
 *
 * @param {object} mod A loaded module.
 * @returns {{ method: string, path: string, segments: string[], body: object|null, handler: Function }[]} Each route, with its full path.
 * @throws {Error} When a route's method, path or schema is wrong, or two routes are the same.
 */
export function collectRoutes(mod) {
    const found = [];
    const router = {};
    for (const [lower, method] of Object.entries(METHODS)) {
        router[lower] = (routePath, ...rest) => {
            const handler = rest.pop();
            const options = rest.length > 0 ? rest[0] : {};
            if (typeof handler !== 'function') throw new Error('router.' + lower + '(' + routePath + ') needs a handler function');
            if (typeof routePath !== 'string' || !ROUTE_PATH.test(routePath)) throw new Error('router.' + lower + ' path "' + routePath + '" must be "/" or segments like "/items/:id"');
            if (options.body !== undefined) assertSupported(options.body, mod.id + ' ' + method + ' ' + routePath);
            if (options.body !== undefined && method === 'GET') throw new Error('a GET route cannot have a body schema');
            const full = '/api/modules/' + mod.id + (routePath === '/' ? '' : routePath);
            if (found.some((route) => route.method === method && route.path === full)) throw new Error('route ' + method + ' ' + full + ' is declared twice');
            found.push({ method, path: full, segments: full.split('/'), body: options.body || null, handler });
        };
    }
    if (typeof mod.routes === 'function') mod.routes(router);
    return found;
}

/**
 * Matches a request path against a route that may have `:name` parts.
 *
 * @param {string[]} pattern The route's path split on `/`.
 * @param {string} requestPath The request path.
 * @returns {Record<string, string>|null} The parameters, or null when the path does not match.
 */
export function matchPath(pattern, requestPath) {
    const parts = requestPath.split('/');
    if (parts.length !== pattern.length) return null;
    const params = {};
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i].startsWith(':')) {
            if (parts[i] === '') return null;
            try {
                params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
            } catch {
                return null;
            }
        } else if (pattern[i] !== parts[i]) {
            return null;
        }
    }
    return params;
}

/**
 * Reads the query string into a plain object, keeping the first value of a repeated name.
 *
 * @param {Request} request The incoming request.
 * @returns {Record<string, string>} The query.
 */
function queryOf(request) {
    const query = {};
    for (const [key, value] of new URL(request.url).searchParams) {
        if (!Object.hasOwn(query, key)) query[key] = value;
    }
    return query;
}

/**
 * Builds what core.js needs to serve modules, and what the processor needs to run their event handlers.
 *
 * @param {object[]} modules The loaded modules.
 * @param {{ data: object, config: object, log: object, fetch?: typeof fetch }} deps The data provider instance, the config,
 *   the logger and the HTTP client used for `ctx.dropcowboy()`.
 * @returns {{ routes: object[], runEventHooks: (event: object, info: object) => Promise<void> }} The routes, each with a
 *   ready-to-run `step(ctx)` for the core, and the event runner (a no-op when no module listens).
 * @throws {Error} When a module declares a bad route.
 */
export function createModules(modules, deps) {
    const fetchImpl = deps.fetch || globalThis.fetch;
    const dropcowboy = (request) => callDropCowboy(deps.config, fetchImpl, request);
    const routes = [];
    const listeners = [];

    for (const mod of modules) {
        for (const route of collectRoutes(mod)) {
            routes.push({ method: route.method, segments: route.segments, step: routeStep(route, deps, dropcowboy) });
        }
        if (mod.onEvent) listeners.push(mod);
    }

    return {
        routes,

        async runEventHooks(event, info) {
            for (const mod of listeners) {
                const names = [];
                if (typeof event.event === 'string' && Object.hasOwn(mod.onEvent, event.event)) names.push(event.event);
                if (Object.hasOwn(mod.onEvent, '*')) names.push('*');
                for (const name of names) {
                    await mod.onEvent[name](event, {
                        data: deps.data.system(),
                        log: info.log,
                        dropcowboy,
                        signal: info.signal,
                        eventId: info.eventId,
                        attempt: info.attempt
                    });
                }
            }
        }
    };
}

/**
 * Builds the core step that runs one module route.
 *
 * @param {{ method: string, path: string, body: object|null, handler: Function }} route The route.
 * @param {{ data: object }} deps The data provider instance.
 * @param {Function} dropcowboy The Drop Cowboy caller handed to handlers.
 * @returns {(ctx: object) => Promise<Response>} A step: the core calls it after `requireUser` has set `ctx.user`.
 */
function routeStep(route, deps, dropcowboy) {
    return async function runModuleRoute(ctx) {
        await ctx.limit('module-user', ctx.user.id, USER_PER_MINUTE);
        let body;
        if (route.body) {
            body = await readJsonBody(ctx.request);
            if (body === undefined) throw new HttpError(415, 'unsupported_media_type', 'Send this request as application/json.');
            checkBody(route.body, body);
        }
        const result = await route.handler({
            user: ctx.user,
            data: deps.data.scope(ctx.user.id),
            log: ctx.log,
            dropcowboy,
            signal: ctx.request.signal,
            params: ctx.params || {},
            query: queryOf(ctx.request),
            body,
            request: ctx.request,
            reply: (status, value) => new Reply(status, value)
        });
        if (result instanceof Response) return result;
        if (result instanceof Reply) return jsonResponse(result.status, result.body);
        return jsonResponse(200, result === undefined ? {} : result);
    };
}
