import crypto from 'node:crypto';

/**
 * Delivers a webhook the way Drop Cowboy does, signed with `secret`:
 * X-Signature is "sha256=" + hex HMAC-SHA256 of "<timestamp>.<raw body>".
 */
export async function deliverWebhook(serverUrl, secret, { event, data }) {
    const eventId = crypto.randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event_id: eventId, event, event_at: new Date().toISOString(), data });
    const signature = crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
    const response = await fetch(serverUrl + '/webhooks/dropcowboy', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-signature': 'sha256=' + signature,
            'x-signature-version': 'v1',
            'x-timestamp': timestamp,
            'x-event-id': eventId,
            'x-attempt': '1'
        },
        body
    });
    return { status: response.status, eventId };
}
