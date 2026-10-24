/**
 * The one place this server talks to Drop Cowboy: authenticates, enforces a
 * timeout and turns every failure into the error envelope.
 *
 * Where it sits: tokenRoute() and readinessRoute() -> callDropCowboy() ->
 * `fetch` -> Drop Cowboy API.
 *
 * CONTRACT.md: "Passing through Drop Cowboy errors".
 * What a customer changes: nothing; call it from your own routes.
 */

import { HttpError, fromUpstream } from './errors.js';

const USER_AGENT = 'dropcowboy-starter-crm/0.1 (node)';

/** A read is tried at most this many times in total: enough to ride out a blip, few enough not to pile on an outage. */
const MAX_READ_ATTEMPTS = 3;

/** First backoff before a retry; doubles each time. */
const BASE_BACKOFF_MS = 150;

/** Extra random wait added after a Retry-After, so callers throttled together do not return together. */
const JITTER_MS = 100;

/** A Retry-After longer than this is passed to the caller instead of waited out. */
const MAX_RETRY_AFTER_SECONDS = 2;

/**
 * Calls the Drop Cowboy API and returns the parsed JSON body.
 *
 * It authenticates with this server's API key, or, when `accessToken` is
 * given (login mode), with the signed-in user's token instead. Never both.
 * Redirects are refused, because fetch would resend the credentials to
 * wherever they point.
 *
 * Reads (`GET`) are retried up to 3 attempts in total, after a network error,
 * a 5xx, or a 429 whose `Retry-After` is 2 seconds or less. Timeouts, other
 * 4xx answers, and every non-GET call are never retried.
 *
 * @param {object} config Validated config (apiBase, apiKey, apiSecret, timeoutMs).
 * @param {typeof fetch} fetchImpl The fetch to use.
 * @param {{ method: string, path: string, body?: object, accessToken?: string }} request What to send.
 * @returns {Promise<any>} The parsed JSON body.
 * @throws {HttpError} 401 `login_expired` when a user's token was refused;
 *   504 `upstream_timeout`; 502 `upstream_unreachable` or `upstream_error`;
 *   or the mapped upstream 4xx from fromUpstream().
 */
export async function callDropCowboy(config, fetchImpl, { method, path, body, accessToken }) {
    const headers = {
        'accept': 'application/json',
        'user-agent': USER_AGENT
    };
    if (accessToken) {
        headers['authorization'] = 'Bearer ' + accessToken;
    } else {
        headers['x-key'] = config.apiKey;
        headers['x-secret'] = config.apiSecret;
    }
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
    }

    // Only reads are retried. A mint or any write could repeat a side effect if
    // the first attempt reached Drop Cowboy but its answer was lost.
    const maxAttempts = method === 'GET' ? MAX_READ_ATTEMPTS : 1;
    let attempt = 0;
    for (;;) {
        attempt++;
        let outcome;
        try {
            outcome = await attemptOnce(config, fetchImpl, { method, path, body, headers });
        } catch (err) {
            if (attempt >= maxAttempts || !(err instanceof HttpError) || err.code !== 'upstream_unreachable') throw err;
            await sleep(backoffMs(attempt));
            continue;
        }
        const wait = retryDelayMs(outcome.response, attempt);
        if (wait === null || attempt >= maxAttempts) return interpret(outcome, accessToken);
        await sleep(wait);
    }
}

/**
 * Makes one request and reads the whole answer.
 *
 * @param {object} config Validated config.
 * @param {typeof fetch} fetchImpl The fetch to use.
 * @param {object} request What to send.
 * @returns {Promise<{ response: Response, json: unknown }>} The answer.
 * @throws {HttpError} 504 `upstream_timeout` or 502 `upstream_unreachable`.
 */
async function attemptOnce(config, fetchImpl, { method, path, body, headers }) {
    const response = await fetchImpl(config.apiBase + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // fetch would resend the credentials to wherever a redirect points.
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs)
    }).catch(networkError);
    const text = await response.text().catch(networkError);
    return { response, json: parseJson(text) };
}

/**
 * Turns the final answer into a result or an error.
 *
 * @param {{ response: Response, json: unknown }} outcome The last attempt.
 * @param {string|undefined} accessToken The login-mode token, when one was used.
 * @returns {object} The parsed JSON body.
 * @throws {HttpError} Per the contract's error mapping.
 */
function interpret({ response, json }, accessToken) {
    // The user's sign-in, not this server's key, was refused: the browser
    // should sign in again, so this stays a 401.
    if (response.status === 401 && accessToken) {
        throw new HttpError(401, 'login_expired', 'Your Drop Cowboy sign-in has expired. Sign in again.');
    }
    if (!response.ok) {
        throw fromUpstream(response.status, json, response.headers);
    }
    if (json === null) {
        throw new HttpError(502, 'upstream_error', 'Drop Cowboy sent a response this server could not read.');
    }
    return json;
}

/**
 * Whether an answer is worth another attempt, and how long to wait first.
 *
 * @param {Response} response The answer.
 * @param {number} attempt Which attempt this was, from 1.
 * @returns {number|null} Milliseconds to wait, or null to stop.
 */
function retryDelayMs(response, attempt) {
    if (response.status >= 500) return backoffMs(attempt);
    if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        // A short throttle is worth waiting out; a long one is the caller's to hear about.
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_RETRY_AFTER_SECONDS) {
            return Math.round(seconds * 1000) + jitter(JITTER_MS);
        }
    }
    return null;
}

/**
 * Exponential backoff with jitter, so many callers do not retry in lockstep.
 *
 * @param {number} attempt The attempt that just failed, from 1.
 * @returns {number} Milliseconds to wait.
 */
function backoffMs(attempt) {
    const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    return Math.round(ceiling / 2 + jitter(ceiling / 2));
}

function jitter(max) {
    return Math.random() * max;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkError(err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new HttpError(504, 'upstream_timeout', 'Drop Cowboy did not answer in time. Try again shortly.');
    }
    throw new HttpError(502, 'upstream_unreachable', 'This server could not reach Drop Cowboy.');
}

function parseJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
