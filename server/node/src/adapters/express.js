/**
 * The Express adapter: the only file that knows about Express.
 *
 * Where it sits: `createApp()` mounts one catch-all middleware. It turns each
 * Node request into a web `Request`, calls `core.handle()`, and writes the web
 * `Response` back, streaming its body so Server-Sent Events work. Hono, Next.js
 * and Netlify Functions get adapters of the same size, because the routes live
 * in `core.js`.
 *
 * CONTRACT.md: not applicable; the adapter adds no behavior of its own.
 * What a customer changes: nothing. To mount the CRM inside an existing
 * Express app, use `app.use(createApp(config))`.
 */

import { once } from 'node:events';
import { Readable } from 'node:stream';
import express from 'express';
import { errorResponse } from '../errors.js';

/**
 * Builds the web `Request` for a Node request.
 *
 * @param {import('http').IncomingMessage} req The Node request.
 * @param {AbortSignal} signal Aborts when the client disconnects, so streaming
 *   handlers can stop.
 * @returns {Request} An equivalent web request.
 */
function toRequest(req, signal) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
            headers.set(name, value);
        }
    }
    const protocol = req.socket.encrypted ? 'https' : 'http';
    const init = { method: req.method, headers, signal };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        // A web request body is a stream; Node needs `duplex` to accept one.
        init.body = Readable.toWeb(req);
        init.duplex = 'half';
    }
    try {
        return new Request(protocol + '://' + (req.headers.host || 'localhost') + req.url, init);
    } catch {
        // A Host header that is not a valid authority: fall back so the request
        // can still be answered.
        return new Request(protocol + '://localhost' + req.url, init);
    }
}

/**
 * Writes a web `Response` to a Node response, honoring back-pressure.
 *
 * @param {Response} response What the core answered.
 * @param {import('http').ServerResponse} res The Node response.
 * @returns {Promise<void>} Resolves when the body has been written or the client left.
 */
async function writeResponse(response, res) {
    res.statusCode = response.status;
    for (const [name, value] of response.headers) {
        // Several Set-Cookie headers must not be folded into one.
        if (name !== 'set-cookie') res.setHeader(name, value);
    }
    for (const cookie of response.headers.getSetCookie()) {
        res.appendHeader('set-cookie', cookie);
    }
    if (!response.body) {
        res.end();
        return;
    }

    // Send the headers now: a stream such as /api/events may not write a
    // chunk for a while, and the browser needs the 200 to open the stream.
    res.flushHeaders();
    const reader = response.body.getReader();
    const stop = () => reader.cancel().catch(() => {});
    res.on('close', stop);
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) await once(res, 'drain');
        }
    } catch {
        // The client went away mid-write; nothing left to tell it.
    } finally {
        res.off('close', stop);
        res.end();
    }
}

/**
 * Mounts a core on a new Express app.
 *
 * @param {{ handle: Function, lifecycle: object, runtime: object, store: object }} core From createCore().
 * @param {object} config The loaded config, for `trust proxy`.
 * @returns {import('express').Express} An Express app that answers every request through `core`.
 */
export function expressAdapter(core, config) {
    const app = express();
    app.disable('x-powered-by');
    // DC_TRUST_PROXY: hop count for X-Forwarded-* when behind a reverse proxy.
    app.set('trust proxy', config.trustProxy ?? 0);
    app.set('lifecycle', core.lifecycle);
    app.set('runtime', core.runtime);
    app.set('eventStore', core.store);

    app.use(async (req, res) => {
        const controller = new AbortController();
        // `close` also fires after a normal finish, so only abort when the
        // response did not complete: that is a client that left.
        res.on('close', () => {
            if (!res.writableFinished) controller.abort();
        });
        let response;
        try {
            const request = toRequest(req, controller.signal);
            response = await core.handle(request, {
                remoteAddress: req.socket.remoteAddress,
                rawPath: req.url.split('?')[0]
            });
        } catch {
            response = errorResponse(400, 'bad_request', 'The request could not be read.');
        }
        await writeResponse(response, res);
    });
    return app;
}
