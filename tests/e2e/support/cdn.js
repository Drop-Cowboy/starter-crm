import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDN_ORIGIN, DEFAULT_CDN_VERSION } from '../../../shared/config.js';

// The pages load Building Blocks from https://webforms.dropcowboy.com/v<version>/.
// The tests answer those requests from a local folder instead, with the
// browser still checking each script against the integrity hash in the
// manifest.
//
// The folder is the first of:
//   1. DC_E2E_CDN_DIR, if set;
//   2. v2/app/src/assets, when this starter sits in the Drop Cowboy monorepo;
//   3. tests/e2e/.cdn-cache/v<DEFAULT_CDN_VERSION>, the pinned release, which
//      global-setup.js downloads once and git ignores.
//
// Building Blocks are closed source and are never committed with this starter.

export { CDN_ORIGIN };

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = 'building-blocks-manifest.json';
const CACHE = path.join(here, '..', '.cdn-cache');
// The CDN caches its CORS headers from the first request for each file, so a
// request without an Origin would break the file for every browser after it.
const DOWNLOAD_ORIGIN = 'http://localhost:8080';

export function localCdnDir() {
    const candidates = [
        process.env.DC_E2E_CDN_DIR,
        path.join(here, '..', '..', '..', '..', '..', '..', 'app', 'src', 'assets')
    ].filter(Boolean);
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, MANIFEST))) {
            return path.resolve(dir);
        }
    }
    if (process.env.DC_E2E_CDN_DIR) {
        throw new Error('DC_E2E_CDN_DIR is set, but ' + process.env.DC_E2E_CDN_DIR + ' has no ' + MANIFEST + '.');
    }
    return null;
}

export function cachedCdnDir(version = DEFAULT_CDN_VERSION) {
    return path.join(CACHE, 'v' + version);
}

export function findCdnDir() {
    const local = localCdnDir();
    if (local) return local;
    const cached = cachedCdnDir();
    if (fs.existsSync(path.join(cached, MANIFEST))) return cached;
    throw new Error('No Building Blocks bundles found. Run the browser tests with Playwright, whose global setup downloads release '
        + DEFAULT_CDN_VERSION + ' into ' + cached + ', or set DC_E2E_CDN_DIR to a folder holding ' + MANIFEST + ' and its bundles.');
}

/**
 * Downloads one release's manifest and production bundles into
 * tests/e2e/.cdn-cache, checking each bundle against its integrity hash. The
 * manifest is written last, so an interrupted download is fetched again.
 */
export async function downloadCdn(version = DEFAULT_CDN_VERSION) {
    const dir = cachedCdnDir(version);
    if (fs.existsSync(path.join(dir, MANIFEST))) return dir;
    const base = CDN_ORIGIN + '/v' + version + '/';
    const manifestBytes = await fetchBytes(base + MANIFEST);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const partial = dir + '.partial-' + process.pid;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
    for (const entry of manifest.files || []) {
        if (entry.kind !== 'block' || !entry.integrity) continue;
        const body = await fetchBytes(base + entry.file);
        if (integrityOf(body) !== entry.integrity) {
            fs.rmSync(partial, { recursive: true, force: true });
            throw new Error(base + entry.file + ' does not match its integrity hash in ' + MANIFEST + '.');
        }
        fs.writeFileSync(path.join(partial, entry.file), body);
    }
    fs.writeFileSync(path.join(partial, MANIFEST), manifestBytes);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(partial, dir);
    return dir;
}

/**
 * Reads the manifest and checks every production bundle in it against its
 * integrity hash, so a stale build fails with a clear message instead of a
 * blank widget.
 */
export function loadCdn(dir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    const integrityByFile = new Map();
    for (const entry of manifest.files || []) {
        if (entry.kind === 'block' && entry.integrity) {
            integrityByFile.set(entry.file, entry.integrity);
        }
    }
    const served = new Set();
    const problems = [];

    function answer(url) {
        // /v3.33.0/dropcowboy-dock.js -> dropcowboy-dock.js
        const file = new URL(url).pathname.split('/').pop();
        const fullPath = path.join(dir, file);
        if (file !== MANIFEST && !integrityByFile.has(file)) {
            problems.push(file + ' is not a production bundle in ' + MANIFEST);
            return { status: 404, body: 'not found' };
        }
        if (!fs.existsSync(fullPath)) {
            problems.push(file + ' is listed in the manifest but missing from ' + dir);
            return { status: 404, body: 'not found' };
        }
        const body = fs.readFileSync(fullPath);
        if (file !== MANIFEST) {
            if (integrityOf(body) !== integrityByFile.get(file)) {
                problems.push(file + ' does not match its integrity hash in ' + MANIFEST
                    + '. The bundles are mid-rebuild or stale. Rebuild the Building Blocks CDN bundles next to ' + MANIFEST + ' and rerun.');
            }
        }
        served.add(file);
        return {
            status: 200,
            body,
            contentType: file.endsWith('.json') ? 'application/json' : 'text/javascript'
        };
    }

    return { dir, answer, served, problems };
}

function integrityOf(body) {
    return 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');
}

async function fetchBytes(url) {
    const response = await fetch(url, { headers: { Origin: DOWNLOAD_ORIGIN } });
    if (!response.ok) {
        throw new Error('Could not download ' + url + ': HTTP ' + response.status);
    }
    return Buffer.from(await response.arrayBuffer());
}
