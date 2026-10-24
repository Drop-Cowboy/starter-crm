// The scheduled maintenance run: re-queue events whose message was lost, and prune past retention.
//
// Where it sits: `vercel.json` has a daily cron for this path. Vercel sends `Authorization: Bearer <CRON_SECRET>` when the
// CRON_SECRET variable is set, and nothing else may call it. A serverless app has no loop between requests, so this is
// what the Node server's maintenance loop becomes. It answers 503 until CRON_SECRET is set, so it is never open.
import crypto from 'node:crypto';
import { core } from '../../../lib/core.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Compares two strings without leaking where they differ.
 *
 * @param {string} given What the caller sent.
 * @param {string} wanted What it must be.
 * @returns {boolean} True when they are equal.
 */
function same(given, wanted) {
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(wanted).digest();
    return crypto.timingSafeEqual(a, b);
}

/**
 * Runs one maintenance pass.
 *
 * @param {Request} request The cron request.
 * @returns {Promise<Response>} 200 when the pass ran, 401 for a wrong secret, 503 when the secret or the server is not set up.
 */
export async function GET(request) {
    const secret = (process.env.CRON_SECRET || '').trim();
    const headers = { 'cache-control': 'no-store' };
    if (secret === '') {
        return Response.json({ error: { code: 'cron_secret_missing', message: 'Set CRON_SECRET to enable the maintenance run.' } }, { status: 503, headers });
    }
    const bearer = (request.headers.get('authorization') || '').replace(/^Bearer /i, '');
    if (!same(bearer, secret)) {
        return Response.json({ error: { code: 'unauthorized', message: 'Missing or wrong credentials.' } }, { status: 401, headers });
    }
    const result = await core();
    if (!result.ok) return Response.json({ error: { code: 'not_ready', message: 'The server is not configured. See the function log.' } }, { status: 503, headers });
    await result.core.runtime.maintainOnce();
    return Response.json({ ok: true }, { headers });
}
