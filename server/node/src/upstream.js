import { HttpError, fromUpstream } from './errors.js';

const USER_AGENT = 'dropcowboy-starter-crm/0.1 (node)';

// Calls the Drop Cowboy API and returns the parsed JSON body. Every failure
// becomes an HttpError in the contract's envelope.
//
// It authenticates with this server's API key, or, when `accessToken` is
// given (login mode), with the signed-in user's token instead. Never both.
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

    const response = await fetchImpl(config.apiBase + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // fetch would resend the credentials to wherever a redirect points.
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs)
    }).catch(networkError);

    const text = await response.text().catch(networkError);
    const json = parseJson(text);

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
