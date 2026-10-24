/**
 * Serves the front-ends: the vanilla app at `/`, the React build at `/react/`
 * and the shared ES modules at `/shared/`.
 *
 * Where it sits: last in the core's routing, after every API route. It uses
 * only `node:fs` and web `Response`, so any adapter can mount it.
 *
 * CONTRACT.md: "Static files".
 * What a customer changes: nothing, unless you move the front-end folders.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { notFound } from './errors.js';

/** Paths the static files never answer, even when no route matched them. */
export const RESERVED_PREFIXES = ['/api', '/__dev', '/webhooks', '/internal', '/healthz', '/readyz'];

const NO_VANILLA = [
    'The Starter CRM server is running, but there is no front-end to serve yet.',
    '',
    'Vanilla (no build step): the files in vanilla/ at the starter root are served here.',
    'React: cd react && npm install && npm run dev, then open http://localhost:5173/react/',
    '',
    'See README.md at the starter root.'
].join('\n');

const NO_REACT = [
    'The React app has not been built yet.',
    '',
    'Build it to serve it here:  cd react && npm install && npm run build',
    'Or run its dev server:      cd react && npm run dev, then open http://localhost:5173/react/'
].join('\n');

// The types the front-ends use. `.js` and `.mjs` must be text/javascript:
// browsers refuse to run a module served as anything else.
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm'
};

/**
 * Content types worth compressing: text a browser reads, not images or fonts
 * that are already compressed.
 */
const COMPRESSIBLE_TYPES = new Set([
    'text/html', 'text/javascript', 'text/css', 'application/json', 'image/svg+xml', 'text/plain'
]);

/** Below this size, gzip's header costs more than it saves. */
const MIN_COMPRESS_BYTES = 1024;

/**
 * Files Vite writes into `react/dist/assets/`, whose names carry a content
 * hash (`index-BWradlQu.js`). A changed file gets a new name, so the old name
 * can be cached for a year without ever going stale.
 */
export const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** One year, the longest a cache is expected to honour. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Compressed bodies by file and version, so each file is gzipped once, not on
 * every request. The key holds the ETag, which changes whenever the file does.
 * Capped so a large folder cannot grow memory without limit.
 */
const gzipCache = new Map();
const GZIP_CACHE_LIMIT = 200;

/**
 * True when `urlPath` is one of `prefixes` or inside one. `/apix` is not under `/api`.
 *
 * @param {string} urlPath A URL path starting with `/`.
 * @param {string[]} prefixes URL prefixes without a trailing slash.
 * @returns {boolean} Whether the path falls under a prefix.
 */
export function isUnder(urlPath, prefixes) {
    return prefixes.some((prefix) => urlPath === prefix || urlPath.startsWith(prefix + '/'));
}

/**
 * Builds the static handler for the three trees.
 *
 * @param {{ root: string }} config Validated config; `root` holds the folders.
 * @returns {(ctx: object) => Promise<Response>} Handler for GET and HEAD
 *   requests that matched no route; 404 `not_found` for anything it will not serve.
 */
export function staticRoutes(config) {
    const root = path.resolve(config.root);
    const shared = path.join(root, 'shared');
    const react = path.join(root, 'react', 'dist');
    const vanilla = path.join(root, 'vanilla');

    return async function serveStatic(ctx) {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
            return notFound(ctx);
        }
        if (isUnder(ctx.path, ['/shared'])) {
            return serveShared(ctx, shared, ctx.path.slice('/shared'.length));
        }
        if (isUnder(ctx.path, ['/react'])) {
            return serveFrontEnd(ctx, react, NO_REACT, ctx.path.slice('/react'.length));
        }
        return serveFrontEnd(ctx, vanilla, NO_VANILLA, ctx.path);
    };
}

/**
 * Serves the ES modules the no-build front-end imports. Files only: no index
 * page, no listing and no fallback, so a missing module is a plain 404. A
 * backslash is a path separator on Windows alone, so it is refused everywhere.
 *
 * @param {object} ctx The request context.
 * @param {string} dir Absolute path of the `shared/` folder.
 * @param {string} relative The URL path after `/shared`.
 * @returns {Promise<Response>} The file, or 404 `not_found`.
 */
async function serveShared(ctx, dir, relative) {
    const name = decode(relative.replace(/^\/+/, ''));
    if (name === null || name.includes('\\') || hasHiddenPart(name)) {
        return notFound(ctx);
    }
    const file = safeJoin(dir, name);
    if (file === null || !isFile(file)) {
        return notFound(ctx);
    }
    return sendFile(ctx, file);
}

/**
 * Serves one front-end folder. Paths that match no file fall back to
 * index.html for page loads, so client-side routes survive a reload.
 *
 * @param {object} ctx The request context.
 * @param {string} dir Absolute folder to serve.
 * @param {string} missingText Plain text shown when the folder has no index.html.
 * @param {string} relative The URL path after the mount prefix: empty, or starting with `/`.
 * @returns {Promise<Response>} The file, a redirect, the index page or 404.
 */
async function serveFrontEnd(ctx, dir, missingText, relative) {
    const found = findFile(dir, relative);
    if (found !== null && fs.statSync(found).isDirectory()) {
        // Like express.static did: a folder without its trailing slash redirects,
        // so relative links inside its index.html resolve correctly.
        return new Response(null, { status: 301, headers: { location: ctx.path + '/' } });
    }
    if (found !== null) {
        // Only the React build's hashed asset files are immutable; the page itself never is.
        const hashed = dir.endsWith(path.join('react', 'dist')) && HASHED_ASSET.test(relative);
        return sendFile(ctx, found, { immutable: hashed });
    }

    const index = path.join(dir, 'index.html');
    if (!fs.existsSync(index)) {
        return new Response(missingText + '\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if ((ctx.request.headers.get('accept') || '').includes('text/html')) {
        return sendFile(ctx, index);
    }
    return notFound(ctx);
}

/**
 * The file or folder to send, or null when nothing safe matches.
 *
 * `..` segments and names starting with `.` (such as `.env`) are refused, and
 * the joined path must stay inside the folder, so nothing outside it is ever served.
 *
 * @param {string} dir Absolute front-end folder.
 * @param {string} relative URL path after the mount prefix.
 * @returns {string | null} An absolute path that exists, or null.
 */
function findFile(dir, relative) {
    if (relative === '') {
        // The mount itself without its slash, such as /react.
        return isDirectory(dir) ? dir : null;
    }
    let name = decode(relative.replace(/^\/+/, ''));
    if (name === null) return null;
    if (name === '' || name.endsWith('/')) name += 'index.html';
    if (hasHiddenPart(name)) return null;
    const file = safeJoin(dir, name);
    return file !== null && fs.existsSync(file) ? file : null;
}

/**
 * Percent-decodes a URL path.
 *
 * @param {string} value A URL path without its leading slash.
 * @returns {string | null} The decoded text, or null when it is malformed or holds a NUL byte.
 */
function decode(value) {
    try {
        const decoded = decodeURIComponent(value);
        return decoded.includes('\0') ? null : decoded;
    } catch {
        return null;
    }
}

/**
 * Whether any path segment is `.`/`..` or starts with a dot.
 *
 * @param {string} name A decoded relative path.
 * @returns {boolean} True when a segment must never be served.
 */
function hasHiddenPart(name) {
    return name.split('/').some((part) => part.startsWith('.'));
}

/**
 * Joins `name` onto `dir` and checks the result is still inside `dir`.
 *
 * @param {string} dir Absolute folder.
 * @param {string} name A decoded relative path.
 * @returns {string | null} The absolute path, or null when it would escape.
 */
function safeJoin(dir, name) {
    const joined = path.resolve(dir, name);
    return joined === dir || joined.startsWith(dir + path.sep) ? joined : null;
}

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function isDirectory(file) {
    try {
        return fs.statSync(file).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Whether the browser said it can decode gzip.
 *
 * @param {string|null} header The `Accept-Encoding` request header.
 * @returns {boolean} True when `gzip` is listed and not refused with `q=0`.
 */
function acceptsGzip(header) {
    if (!header) return false;
    for (const part of header.split(',')) {
        const [name, ...params] = part.trim().split(';');
        if (name.trim().toLowerCase() !== 'gzip') continue;
        const q = params.map((item) => item.trim()).find((item) => item.toLowerCase().startsWith('q='));
        return q === undefined || Number(q.slice(2)) > 0;
    }
    return false;
}

/**
 * The gzipped bytes of a file, from the cache when this version was seen.
 *
 * @param {string} file Absolute path of the file.
 * @param {string} etag The file's current ETag, which names this version.
 * @returns {Buffer} The compressed file.
 */
function gzipped(file, etag) {
    const key = file + '|' + etag;
    let body = gzipCache.get(key);
    if (!body) {
        body = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
        if (gzipCache.size >= GZIP_CACHE_LIMIT) {
            gzipCache.delete(gzipCache.keys().next().value);
        }
        gzipCache.set(key, body);
    }
    return body;
}

/**
 * Streams a file as a response, with the validators browsers need to
 * revalidate cheaply: a weak ETag, Last-Modified and a 304 for a match.
 *
 * Caching: a hashed build asset is `immutable` for a year; everything else is
 * `no-cache`, so the browser may keep it but must ask before using it, and the
 * ETag turns that question into a 304. A new deploy therefore shows up on the
 * next page load, while the heavy assets are never fetched twice.
 *
 * Compression: text types of 1 KB or more are sent gzipped when the browser
 * accepts it, with `Vary: Accept-Encoding` so a cache keeps both versions.
 *
 * @param {object} ctx The request context.
 * @param {string} file Absolute path of a regular file.
 * @param {{ immutable?: boolean }} [options] `immutable` marks a content-hashed file.
 * @returns {Response} 200 with the file, or 304.
 */
function sendFile(ctx, file, options = {}) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return notFound(ctx);
    }
    if (!stat.isFile()) {
        return notFound(ctx);
    }

    const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
    const contentType = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const compressible = COMPRESSIBLE_TYPES.has(contentType.split(';')[0]) && stat.size >= MIN_COMPRESS_BYTES;
    const headers = new Headers({
        'content-type': contentType,
        'content-length': String(stat.size),
        'cache-control': options.immutable ? IMMUTABLE_CACHE : 'no-cache',
        'etag': etag,
        'last-modified': stat.mtime.toUTCString()
    });
    if (compressible) {
        headers.set('vary', 'Accept-Encoding');
    }
    if (ctx.request.headers.get('if-none-match') === etag) {
        headers.delete('content-length');
        return new Response(null, { status: 304, headers });
    }
    const gzip = compressible && acceptsGzip(ctx.request.headers.get('accept-encoding'));
    if (gzip) {
        headers.set('content-encoding', 'gzip');
    }
    if (ctx.method === 'HEAD') {
        if (gzip) headers.delete('content-length');
        return new Response(null, { status: 200, headers });
    }
    if (gzip) {
        const body = gzipped(file, etag);
        headers.set('content-length', String(body.length));
        return new Response(body, { status: 200, headers });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
}
