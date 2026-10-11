import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function sessionFilePath(config) {
    return path.join(config.root, '.dropcowboy', 'session.json');
}

// Development only (DC_AUTH_MODE=mcp-session). An AI agent minted a site token
// with the Drop Cowboy MCP and wrote it to .dropcowboy/session.json; this hands
// it to the browser on the same machine and to nobody else.
export function devSessionRoute(config) {
    return async function getDevSession(req, res) {
        // The TCP peer, never X-Forwarded-For: any client can send that header.
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
            throw new HttpError(403, 'loopback_only', 'The dev session is only served to this machine.');
        }
        // A hostile page can point its own hostname at 127.0.0.1 (DNS
        // rebinding). Its requests still carry that hostname in Host.
        if (!isLoopbackHost(req.headers.host)) {
            throw new HttpError(403, 'loopback_only', 'Open the app at http://localhost or http://127.0.0.1.');
        }

        const session = await readSession(sessionFilePath(config), Date.now());
        res.set('Cache-Control', 'no-store');
        res.json({
            token: session.token,
            expires_at: session.expires_at,
            site_id: typeof session.site_id === 'string' && session.site_id ? session.site_id : config.siteId
        });
    };
}

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

export function isLoopbackAddress(address) {
    if (typeof address !== 'string') return false;
    const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
    return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

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
