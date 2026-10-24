/**
 * Development-only handoff of a site token from an AI agent to the browser.
 *
 * Where it sits: browser -> `/__dev/session` -> this file -> reads
 * `.dropcowboy/session.json`. Only registered when DC_AUTH_MODE=mcp-session,
 * which production refuses to boot with.
 *
 * CONTRACT.md: "GET /__dev/session".
 * What a customer changes: nothing; delete the mode when you no longer use it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';
import { jsonResponse } from './http.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where the agent writes the session file.
 *
 * @param {{ root: string }} config Validated config.
 * @returns {string} Absolute path to `.dropcowboy/session.json` under the starter root.
 */
export function sessionFilePath(config) {
    return path.join(config.root, '.dropcowboy', 'session.json');
}

// Development only (DC_AUTH_MODE=mcp-session). An AI agent minted a site token
// with the Drop Cowboy MCP and wrote it to .dropcowboy/session.json; this hands
// it to the browser on the same machine and to nobody else.
/**
 * Builds the handler for `GET /__dev/session`.
 *
 * Refuses any peer that is not loopback and any Host header that is not
 * loopback (DNS rebinding), so the token only ever reaches this machine.
 *
 * @param {{ root: string, siteId: (string|null) }} config Validated config.
 * @returns {(ctx: object) => Promise<Response>} Async handler.
 * @throws {HttpError} 403 `loopback_only`, 404 `session_not_found`,
 *   500 `session_invalid`, 410 `session_expired` (from the handler).
 */
export function devSessionRoute(config) {
    return async function getDevSession(ctx) {
        // The TCP peer, never X-Forwarded-For: any client can send that header.
        if (!isLoopbackAddress(ctx.remoteAddress)) {
            throw new HttpError(403, 'loopback_only', 'The dev session is only served to this machine.');
        }
        // A hostile page can point its own hostname at 127.0.0.1 (DNS
        // rebinding). Its requests still carry that hostname in Host.
        if (!isLoopbackHost(ctx.request.headers.get('host'))) {
            throw new HttpError(403, 'loopback_only', 'Open the app at http://localhost or http://127.0.0.1.');
        }

        const session = await readSession(sessionFilePath(config), Date.now());
        return jsonResponse(200, {
            token: session.token,
            expires_at: session.expires_at,
            site_id: typeof session.site_id === 'string' && session.site_id ? session.site_id : config.siteId
        }, { 'cache-control': 'no-store' });
    };
}

/**
 * Reads and validates the session file.
 *
 * @param {string} file Absolute path of the session file.
 * @param {number} now Current time in epoch milliseconds, passed in so tests control it.
 * @returns {Promise<{ token: string, expires_at: number, site_id?: string }>} The parsed session.
 * @throws {HttpError} 404 `session_not_found`, 500 `session_invalid`, 410 `session_expired`.
 */
export async function readSession(file, now) {
    const text = await fs.readFile(file, 'utf8').catch((err) => {
        if (err.code === 'ENOENT') {
            throw new HttpError(404, 'session_not_found',
                'No .dropcowboy/session.json yet. Ask your AI agent to mint a site token with the Drop Cowboy MCP ' +
                '(mint_embed_token) and write { token, expires_at, site_id } to .dropcowboy/session.json in the starter folder.');
        }
        throw err;
    });

    const session = parseObject(text);
    if (!session || typeof session.token !== 'string' || session.token === '') {
        throw new HttpError(500, 'session_invalid', '.dropcowboy/session.json must be JSON with a string "token".');
    }
    if (typeof session.expires_at !== 'number' || session.expires_at < 1e12) {
        throw new HttpError(500, 'session_invalid', '.dropcowboy/session.json "expires_at" must be epoch milliseconds.');
    }
    if (session.expires_at <= now) {
        throw new HttpError(410, 'session_expired', 'The dev session token has expired. Ask your AI agent to mint a new one.');
    }
    return session;
}

/**
 * Whether a socket address is this machine.
 *
 * @param {string} address The TCP peer address, for example `127.0.0.1` or `::ffff:127.0.0.1`.
 * @returns {boolean} True for IPv4 127.x.x.x and IPv6 ::1.
 */
export function isLoopbackAddress(address) {
    if (typeof address !== 'string') return false;
    const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
    return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/**
 * Whether a Host header names this machine. A hostile page can point its own
 * hostname at 127.0.0.1, but its requests still carry that hostname.
 *
 * @param {string} hostHeader The raw `Host` header.
 * @returns {boolean} True for localhost, 127.0.0.1 and [::1], with or without a port.
 */
export function isLoopbackHost(hostHeader) {
    if (typeof hostHeader !== 'string' || hostHeader === '') return false;
    const host = hostHeader.toLowerCase();
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return LOOPBACK_HOSTNAMES.has(hostname);
}

function parseObject(text) {
    try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}
