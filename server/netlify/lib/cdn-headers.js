/**
 * The `_headers` file for Netlify's CDN: the core's security headers on every file, and the core's caching for each
 * file it serves.
 *
 * Where it sits: scripts/build.mjs writes its output into dist/. The headers are computed from the same config, and by
 * the same function, as the core's own responses, so the policy follows DC_AUTH_MODE, AUTH0_DOMAIN, DC_CSP and DC_ENV.
 * The caching matches server/node/src/static.js: a year for the React build's hashed assets, and `no-cache` (revalidate
 * on every load) for everything else. Netlify joins the values of a header that two matching rules set, so the `/*`
 * rule sets no Cache-Control and each file gets an exact rule of its own.
 *
 * What a customer changes: nothing.
 */

import { applySecurityHeaders } from '../../node/src/security.js';
import { HASHED_ASSET, IMMUTABLE_CACHE } from '../../node/src/static.js';

const REACT = '/react';

/**
 * @param {object} config The loaded config.
 * @param {string[]} files Every file in dist/, as a URL path such as `/react/index.html`.
 * @returns {string} The file's contents.
 */
export function headersFile(config, files) {
    const response = new Response(null);
    applySecurityHeaders(response, config);
    const lines = ['/*'];
    for (const [name, value] of response.headers) lines.push('  ' + name + ': ' + value);
    for (const file of [...files].sort()) {
        if (file === '/_headers') continue;
        const hashed = file.startsWith(REACT + '/') && HASHED_ASSET.test(file.slice(REACT.length));
        const cache = hashed ? IMMUTABLE_CACHE : 'no-cache';
        for (const url of urlsFor(file)) lines.push('', url, '  cache-control: ' + cache);
    }
    return lines.join('\n') + '\n';
}

/**
 * @param {string} file A file's URL path.
 * @returns {string[]} The URLs that serve it: an index.html is also served at its folder's address.
 */
function urlsFor(file) {
    if (!file.endsWith('/index.html')) return [file];
    return [file.slice(0, -'index.html'.length), file];
}
