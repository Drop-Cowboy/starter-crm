import { errorFromResponse, networkError } from './errors.js';

// Calls to the Starter CRM server (see server/CONTRACT.md). Paths are
// same-origin, such as /api/config. Errors come back in the server's
// { error: { code, message } } envelope and are thrown as AppError.

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, fetch?: typeof fetch }} [options]
 * @returns {Promise<any>}
 */
export async function callServer(path, options) {
    const opts = options || {};
    const fetchImpl = opts.fetch || globalThis.fetch;
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers);
    const init = { method: opts.method || 'GET', headers, credentials: 'same-origin', cache: 'no-store' };
    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
    }

    let response;
    try {
        response = await fetchImpl(path, init);
    } catch {
        throw networkError();
    }
    if (!response.ok) {
        throw await errorFromResponse(response);
    }
    return response.json();
}
