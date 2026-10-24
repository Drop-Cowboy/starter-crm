/**
 * Loads the Starter CRM core for the Next.js routes.
 *
 * Where it sits: every route file calls `handle()` (or `core()`) from here. The first request boots the core from
 * `../node/src` (config, providers, secrets, store); later requests on the same instance reuse it. A boot that fails
 * is not remembered, so fixing an environment variable and redeploying (or the next request, when the variable came
 * from a secrets provider) is enough.
 *
 * - The core is imported by file URL with the bundler told to leave it alone: it reads its migrations, schemas and
 *   front-end files from disk, which a bundle would move.
 * - Nothing here starts a loop or leaves work behind. Every promise is awaited before a response is returned, which is
 *   what a serverless host needs (it freezes the instance as soon as the response ends).
 *
 * CONTRACT.md: "Boot", "Internal routes".
 * What a customer changes: nothing.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The boot in flight or done, shared on `globalThis` so scripts/serve.mjs (outside the bundle) can drain the same core. */
const SHARED = '__starterCrmCore';

/**
 * Where the core's source is: `STARTER_CRM_NODE_DIR`, else `server/node` next to this app (the working directory is
 * this app's folder under `next start` and `next dev`, and under Vercel with this folder as the project root).
 *
 * @returns {string} An absolute folder.
 */
function nodeDir() {
    const named = (process.env.STARTER_CRM_NODE_DIR || '').trim();
    return named ? path.resolve(named) : path.resolve(process.cwd(), '..', 'node');
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
        const file = path.join(nodeDir(), 'src', 'serverless.js');
        const { bootCore } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(file).href);
        const result = await bootCore(process.env);
        if (!result.ok) {
            console.error('The Starter CRM server cannot start:\n' + result.text);
            return result;
        }
        // Under scripts/serve.mjs the app is a long-running server, so it runs the worker and maintenance loop like
        // the Node server. On Vercel nothing runs between requests: the queue calls back and the cron maintains.
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
 * The first address in a header value.
 *
 * @param {string|null} value A header value.
 * @returns {string|undefined} The first address in it, trimmed, or undefined.
 */
function firstAddress(value) {
    const first = (value || '').split(',')[0].trim();
    return first || undefined;
}

/**
 * The TCP peer and the path as sent, from the places a route handler can trust.
 *
 * On Vercel the platform's proxy sets `x-real-ip` and replaces any client-sent forwarding header. Under
 * scripts/serve.mjs the launcher stamps both values from the socket and the raw URL, replacing anything the client
 * sent. Anywhere else (for example plain `next start`) there is no trustworthy peer, so none is given and the
 * local-only dev session refuses.
 *
 * @param {Request} request The route handler's request.
 * @param {string} fallbackPath The path Next resolved.
 * @returns {{ remoteAddress: string|undefined, rawPath: string }} What the core takes as host information.
 */
function hostInfo(request, fallbackPath) {
    if (process.env.STARTER_CRM_LAUNCHER === 'on') {
        return {
            remoteAddress: firstAddress(request.headers.get('x-starter-crm-peer')),
            rawPath: request.headers.get('x-starter-crm-raw-path') || fallbackPath
        };
    }
    if (process.env.VERCEL) {
        return { remoteAddress: firstAddress(request.headers.get('x-real-ip')) || firstAddress(request.headers.get('x-forwarded-for')), rawPath: fallbackPath };
    }
    return { remoteAddress: undefined, rawPath: fallbackPath };
}

/**
 * The request with the address the client used.
 *
 * Under `next start` Next builds `request.url` from its own host name, not the `Host` header, so a browser at
 * `127.0.0.1` is "cross-origin" to the core's CSRF check. The Node server's Express adapter builds the URL from `Host`;
 * the launcher does the same here. On Vercel the platform's host is already right, so nothing changes there.
 *
 * @param {Request} request The route handler's request.
 * @param {URL} url The parsed `request.url`.
 * @returns {Request} The same request, or a copy addressed to the `Host` header.
 */
function addressedAsSent(request, url) {
    if (process.env.STARTER_CRM_LAUNCHER !== 'on') return request;
    const host = (request.headers.get('host') || '').trim();
    if (!host || host === url.host || !/^[A-Za-z0-9.\-[\]:]+$/.test(host)) return request;
    const rebuilt = new URL(request.url);
    rebuilt.host = host;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    return new Request(rebuilt, { method: request.method, headers: request.headers, body: hasBody ? request.body : undefined, duplex: 'half', signal: request.signal });
}

/**
 * Answers one request through the core.
 *
 * @param {Request} request The route handler's request.
 * @returns {Promise<Response>} The core's answer, or a 503 when the server cannot boot (the reason is in the function log,
 *   never in the response: it names settings).
 */
export async function handle(request) {
    const result = await core();
    if (!result.ok) {
        return Response.json({ error: { code: 'not_ready', message: 'The server is not configured. See the function log.' } },
            { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const url = new URL(request.url);
    const response = await result.core.handle(addressedAsSent(request, url), hostInfo(request, url.pathname));
    // A HEAD answer carries the GET headers and no body.
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
}
