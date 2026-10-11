// Test doubles for the browser APIs the shared modules use.

export function jsonResponse(status, body, headers) {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
    });
}

/**
 * A fetch that answers from a list of handlers in order, and records every call.
 * Each handler gets (url, init) and returns a Response.
 */
export function scriptedFetch(handlers) {
    const calls = [];
    let next = 0;
    async function fakeFetch(url, init) {
        calls.push({ url: String(url), init: init || {} });
        const handler = handlers[next];
        next += 1;
        if (!handler) {
            throw new Error('Unexpected fetch #' + next + ' to ' + url);
        }
        return handler(String(url), init || {});
    }
    fakeFetch.calls = calls;
    return fakeFetch;
}

export function memoryStorage() {
    const data = new Map();
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
        keys: () => Array.from(data.keys())
    };
}

export function header(init, name) {
    const headers = init.headers || {};
    const wanted = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === wanted) {
            return headers[key];
        }
    }
    return undefined;
}
