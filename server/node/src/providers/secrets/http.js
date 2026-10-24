/**
 * Shared plumbing for the secrets providers that talk to a manager's REST API
 * (`doppler`, `infisical`, `vault`).
 *
 * Where it sits: each of those providers calls `validateBaseUrl()` from its
 * `validate()` and `requestJson()` from its `load()` and `refresh()`. It exists
 * so the three behave identically where it matters for secrets:
 *
 * - The address must be https. Plain http is accepted only for a loopback host
 *   (127.0.0.1, ::1, localhost), which is how a local OpenBao or a test stub is
 *   reached. A bearer token must not cross a network in clear text.
 * - Redirects are an error. A redirect would forward the credential to
 *   whatever host answered, so a response that tries one is reported instead.
 * - Every call has a timeout, because the first call happens at boot and a
 *   hung secrets manager must fail the boot, not freeze it.
 * - Errors say what the manager answered (an HTTP status) or why it could not
 *   be reached, and never include a URL's query, a header or a response body.
 *
 * CONTRACT.md: "Providers" (secrets).
 * What a customer changes: nothing.
 */

import { problem } from '../../problems.js';

/** How long one call to a secrets manager may take. */
export const REQUEST_TIMEOUT_MS = 10000;

/**
 * Checks a manager address setting is a usable base URL.
 *
 * @param {string} variable The setting's name, for the message.
 * @param {string} value The address, as set.
 * @returns {object|null} A boot problem, or null when the address is fine.
 */
export function validateBaseUrl(variable, value) {
    const fix = 'Set ' + variable + ' to an https address such as https://secrets.example.com (http is allowed only for localhost).';
    let url;
    try {
        url = new URL(value);
    } catch {
        return problem('invalid_secrets_url', variable + ' is not a valid URL.', fix);
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        return problem('invalid_secrets_url', variable + ' must be an https address; ' + url.protocol + '// would send credentials in clear text.', fix);
    }
    if (url.username || url.password) {
        return problem('invalid_secrets_url', variable + ' must not contain a user name or password.', fix);
    }
    return null;
}

/**
 * Calls a manager's REST API and parses the JSON it answers.
 *
 * @param {string} label How errors name the manager, for example "Doppler".
 * @param {string} url The full URL.
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown, fetchImpl?: typeof fetch }} [options]
 *   The method (GET by default), the headers, an optional JSON body, and a replacement for `fetch` in tests.
 * @returns {Promise<{ status: number, body: any }>} The status and parsed body. A non-2xx answer throws,
 *   except that the status is attached to the error as `err.status` so a caller can react to 401 or 403.
 */
export async function requestJson(label, url, options = {}) {
    const { method = 'GET', headers = {}, body, fetchImpl = fetch } = options;
    let res;
    try {
        res = await fetchImpl(url, {
            method,
            headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const cause = err && err.cause && err.cause.code ? ' (' + err.cause.code + ')' : '';
        // fetch reports a refused redirect as "fetch failed", with the reason on its cause.
        const redirected = err && /redirect/i.test(String(err.message) + ' ' + String(err.cause && err.cause.message));
        throw new Error(label + (timedOut ? ' did not answer within ' + REQUEST_TIMEOUT_MS / 1000 + ' seconds'
            : redirected ? ' tried to redirect the request, which is refused so the credential is not forwarded'
                : ' could not be reached' + cause), { cause: err });
    }
    if (!res.ok) {
        const err = new Error(label + ' answered HTTP ' + res.status);
        err.status = res.status;
        throw err;
    }
    let parsed;
    try {
        parsed = await res.json();
    } catch {
        throw new Error(label + ' answered something that is not JSON');
    }
    return { status: res.status, body: parsed };
}

/**
 * Keeps only the secrets asked for, and only the ones that hold text.
 *
 * @param {Record<string, unknown>} all Everything a manager returned.
 * @param {string[]} names The names the starter asked for.
 * @returns {Record<string, string>} The requested names that have a non-empty string value.
 */
export function pick(all, names) {
    const out = {};
    for (const key of names) {
        if (Object.hasOwn(all, key) && typeof all[key] === 'string' && all[key] !== '') out[key] = all[key];
    }
    return out;
}
