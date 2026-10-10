// Every error leaves this server as { error: { code, message } }.
// See "Error envelope" in ../../CONTRACT.md.

const STATUS_CODES = {
    400: 'bad-request',
    402: 'payment-required',
    403: 'forbidden',
    404: 'not-found',
    409: 'conflict',
    422: 'unprocessable-entity',
    429: 'too-many-requests'
};

const MAX_MESSAGE_LENGTH = 300;

export class HttpError extends Error {
    constructor(status, code, message, headers = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.headers = headers;
    }
}

export function sendError(res, status, code, message, headers = {}) {
    res.set(headers);
    res.status(status).json({ error: { code, message } });
}

// Maps a Drop Cowboy error response to the envelope. Only the code, a short
// message and Retry-After are kept; the raw upstream body is never echoed.
export function fromUpstream(status, body, headers) {
    if (status === 401) {
        return new HttpError(502, 'upstream_auth_failed',
            'Drop Cowboy rejected this server\'s API key. Check DROPCOWBOY_API_KEY and DROPCOWBOY_API_SECRET.');
    }
    if (status < 400 || status >= 500) {
        return new HttpError(502, 'upstream_error', 'Drop Cowboy could not complete the request. Try again shortly.');
    }

    const extra = {};
    const retryAfter = headers && headers.get('retry-after');
    if (status === 429 && retryAfter) {
        extra['Retry-After'] = retryAfter;
    }
    return new HttpError(status, upstreamCode(status, body), upstreamMessage(status, body), extra);
}

export function upstreamCode(status, body) {
    const b = isObject(body) ? body : {};
    const candidates = [
        isObject(b.detail) ? b.detail.code : null,
        isObject(b.details) ? b.details.code : null,
        b.code,
        b.error,
        typeof b.type === 'string' ? b.type.split('/').pop() : null
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') {
            return candidate.trim();
        }
    }
    return STATUS_CODES[status] || 'bad-request';
}

function upstreamMessage(status, body) {
    const b = isObject(body) ? body : {};
    const candidates = [b.detail, b.message, b.title];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') {
            return candidate.trim().slice(0, MAX_MESSAGE_LENGTH);
        }
    }
    return 'Drop Cowboy refused the request (' + status + ').';
}

export function notFound(req, res) {
    sendError(res, 404, 'not_found', 'No route matches ' + req.method + ' ' + pathOf(req) + '.');
}

export function errorHandler(log) {
    // Express recognises error middleware by its four parameters, so `next`
    // stays even though it is unused.
    return function handleError(err, req, res, next) {
        if (err instanceof HttpError) {
            return sendError(res, err.status, err.code, err.message, err.headers);
        }
        if (err && err.type === 'entity.parse.failed') {
            return sendError(res, 400, 'invalid_json', 'Request body is not valid JSON.');
        }
        if (err && err.type === 'entity.too.large') {
            return sendError(res, 413, 'payload_too_large', 'Request body is larger than 1 MB.');
        }
        log.error('Unhandled error on', req.method, pathOf(req) + ':', err);
        return sendError(res, 500, 'internal_error', 'Something went wrong on this server.');
    };
}

function pathOf(req) {
    return req.originalUrl.split('?')[0];
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
