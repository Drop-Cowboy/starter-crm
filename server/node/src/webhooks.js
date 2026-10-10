import crypto from 'node:crypto';
import { HttpError } from './errors.js';

export const TOLERANCE_SECONDS = 300;

// Drop Cowboy signs `${X-Timestamp}.${body}` with HMAC-SHA256 and the
// webhook's signing secret, and sends `sha256=<hex>` in X-Signature.
// This must run on the exact bytes received: parsing the JSON and serialising
// it again changes spacing or key order, and then nothing verifies.
//
// Each webhook has its own secret, so a delivery is
// valid if any configured secret matches.
export function verifySignature({ rawBody, signature, timestamp, version, secrets, nowSeconds }) {
    if (!signature || !timestamp) {
        return fail('missing_signature', 'X-Signature and X-Timestamp headers are required.');
    }
    if (version && version !== 'v1') {
        return fail('invalid_signature', 'Unsupported X-Signature-Version "' + version + '".');
    }
    if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
        return fail('stale_timestamp', 'X-Timestamp is missing, malformed or more than 5 minutes from now.');
    }

    const received = Buffer.from(signature);
    for (const secret of secrets) {
        const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret)
            .update(timestamp + '.')
            .update(rawBody)
            .digest('hex'));
        if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
            return { ok: true };
        }
    }
    return fail('invalid_signature', 'Signature does not match. Check DROPCOWBOY_WEBHOOK_SECRET.');
}

export function webhookRoute(config, store, log) {
    return function receiveWebhook(req, res) {
        if (config.webhookSecrets.length === 0) {
            throw new HttpError(503, 'webhook_not_configured', 'Set DROPCOWBOY_WEBHOOK_SECRET to receive webhooks.');
        }

        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const check = verifySignature({
            rawBody,
            signature: req.get('x-signature'),
            timestamp: req.get('x-timestamp'),
            version: req.get('x-signature-version'),
            secrets: config.webhookSecrets,
            nowSeconds: Math.floor(Date.now() / 1000)
        });
        if (!check.ok) {
            log.warn('Rejected webhook:', check.code);
            throw new HttpError(401, check.code, check.message);
        }

        const body = parseObject(rawBody.toString('utf8'));
        if (!body) {
            throw new HttpError(400, 'invalid_json', 'Webhook body is not a JSON object.');
        }

        // Drop Cowboy retries with the same event id, so skip ids already seen.
        const eventId = req.get('x-event-id') || (typeof body.event_id === 'string' ? body.event_id : null) || crypto.randomUUID();
        if (store.hasSeen(eventId)) {
            return res.json({ received: true, duplicate: true });
        }

        const attempt = Number.parseInt(req.get('x-attempt'), 10);
        store.add({
            event_id: eventId,
            event: typeof body.event === 'string' ? body.event : null,
            event_at: typeof body.event_at === 'number' ? body.event_at : null,
            received_at: Date.now(),
            attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
            data: body.data !== null && typeof body.data === 'object' ? body.data : {}
        });
        log.info('Webhook', body.event || '(no event type)', eventId);
        return res.json({ received: true });
    };
}

function fail(code, message) {
    return { ok: false, code, message };
}

function parseObject(text) {
    try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}
