/**
 * Loads the Starter CRM core for the Netlify functions.
 *
 * Where it sits: `functions/api.mjs`, `functions/webhook-jobs.mjs` and `functions/maintenance.mjs` call `core()` or
 * `handle()` from here. The first invocation on an instance boots the core from `../node/src` (config, providers,
 * secrets, store); later invocations on the same instance reuse it. A boot that fails is not remembered, so fixing an
 * environment variable and redeploying (or the next request, when the variable came from a secrets provider) is enough.
 *
 * - The core is loaded at run time from where it lives, by a path the bundler cannot follow. Netlify bundles a
 *   function's local imports into one file, and the core must not be bundled: it reads its migrations, schemas, module
 *   folders and front-ends relative to its own files, and loads its providers' packages from ../node/node_modules.
 *   netlify.toml's `node_bundler = "nft"` keeps every file at its own path, and `included_files` ships the core with
 *   its dependencies.
 * - Netlify sets `NETLIFY` only while it builds, not in a function, so this sets it before the core reads its config:
 *   that is what makes the core apply its serverless defaults and refusals. It is not set under `netlify dev` or
 *   scripts/serve.mjs, which are long-running local processes.
 * - Nothing here starts a loop or leaves work behind. Every promise is awaited before a response is returned, which is
 *   what a serverless host needs (it freezes the instance as soon as the response ends).
 *
 * CONTRACT.md: "Boot", "Internal routes".
 * What a customer changes: nothing.
 */

/**
 * The core's source folder. This file and the functions both sit two folders below `server/`, so the address is the
 * same whether it is read here or from a function file this one was bundled into.
 */
const SERVER_SOURCE = new URL('../../node/src/', import.meta.url);

/** The boot in flight or done, shared on `globalThis` so scripts/serve.mjs can drain the same core. */
const SHARED = '__starterCrmCore';

/**
 * Loads one of the core's modules from where it lives.
 *
 * @param {string} name Its path under server/node/src, such as `serverless.js`.
 * @returns {Promise<object>} The module.
 */
export async function coreModule(name) {
    return import(new URL(name, SERVER_SOURCE).href);
}

/**
 * Whether this process is a deployed Netlify function: Netlify's runtime global is there, and neither the launcher
 * nor `netlify dev` is running it.
 *
 * @returns {boolean} True on Netlify's servers.
 */
function deployedOnNetlify() {
    if (process.env.STARTER_CRM_LAUNCHER === 'on' || process.env.NETLIFY_DEV) return false;
    return typeof globalThis.Netlify === 'object' && globalThis.Netlify !== null;
}

/**
 * Boots the core once per instance.
 *
 * @returns {Promise<{ ok: true, core: object, config: object, log: object } | { ok: false, text: string }>} The core, or why it
 *   cannot start.
 */
export async function core() {
    if (globalThis[SHARED]) return globalThis[SHARED];
    const attempt = (async () => {
        if (deployedOnNetlify() && !process.env.NETLIFY) process.env.NETLIFY = 'true';
        const { bootCore } = await coreModule('serverless.js');
        const result = await bootCore(process.env);
        if (!result.ok) {
            console.error('The Starter CRM server cannot start:\n' + result.text);
            return result;
        }
        // Under scripts/serve.mjs the app is a long-running server, so it runs the worker and maintenance loop like
        // the Node server. On Netlify nothing runs between requests: Async Workloads calls back and a schedule maintains.
        if (process.env.STARTER_CRM_LAUNCHER === 'on') await result.core.runtime.start();
        return result;
    })();
    globalThis[SHARED] = attempt;
    try {
        const result = await attempt;
        if (!result.ok) globalThis[SHARED] = null;
        return result;
    } catch (err) {
        globalThis[SHARED] = null;
        console.error('The Starter CRM server could not boot: ' + err.message);
        return { ok: false, text: err.message };
    }
}

/**
 * The answer when the core cannot boot. The reason is in the function log, never in the response: it names settings.
 *
 * @returns {Response} A 503.
 */
export function notReady() {
    return Response.json({ error: { code: 'not_ready', message: 'The server is not configured. See the function log.' } },
        { status: 503, headers: { 'cache-control': 'no-store' } });
}

/**
 * The TCP peer and the path as sent.
 *
 * On Netlify `context.ip` is the connecting client, from Netlify's edge. X-Forwarded-For is not: Netlify keeps
 * whatever the client sent at its front and adds its own hop at the end, which is why the core trusts no proxy hops
 * here (DC_TRUST_PROXY defaults to 0 on Netlify). Under scripts/serve.mjs the launcher stamps both values from the
 * socket and the raw URL, replacing anything the client sent.
 *
 * @param {Request} request The function's request.
 * @param {{ ip?: string }|undefined} context Netlify's function context.
 * @returns {{ remoteAddress: string|undefined, rawPath: string }} What the core takes as host information.
 */
function hostInfo(request, context) {
    const url = new URL(request.url);
    if (process.env.STARTER_CRM_LAUNCHER === 'on') {
        return {
            remoteAddress: request.headers.get('x-starter-crm-peer') || undefined,
            rawPath: request.headers.get('x-starter-crm-raw-path') || url.pathname
        };
    }
    return { remoteAddress: (context && context.ip) || undefined, rawPath: url.pathname };
}

/**
 * Answers one request through the core.
 *
 * @param {Request} request The function's request.
 * @param {object} [context] Netlify's function context.
 * @returns {Promise<Response>} The core's answer, or a 503 when the server cannot boot.
 */
export async function handle(request, context) {
    const result = await core();
    if (!result.ok) return notReady();
    const response = await result.core.handle(request, hostInfo(request, context));
    // A HEAD answer carries the GET headers and no body.
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
}
