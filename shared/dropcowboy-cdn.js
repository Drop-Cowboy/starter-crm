import { CDN_ORIGIN } from './config.js';
import { AppError } from './errors.js';

// Loads Building Blocks bundles from the Drop Cowboy CDN, pinned to one
// release and checked with Subresource Integrity (SRI).
//
// Each release publishes building-blocks-manifest.json next to its bundles.
// Every entry lists the bundle's file, its sha384 `integrity`, the custom
// elements it registers and the window.DropCowboy namespaces it adds. So a
// page asks for what it uses (a tag, or an API such as DropCowboy.dock) and
// the loader finds the bundle. The browser refuses to run a file whose bytes
// do not match the hash, so a tampered or swapped file never executes.

/**
 * @typedef {object} ManifestEntry
 * @property {string} file        e.g. "dropcowboy-dock.js"
 * @property {string} bundle      Two files with the same bundle are the same bytes.
 * @property {string} kind        "block" for production bundles, "playground" for previews.
 * @property {number} bytes
 * @property {string} integrity   "sha384-..."
 * @property {string[]} elements  Custom elements it registers, e.g. "dc-contact-card".
 * @property {string[]} namespaces e.g. "DropCowboy.dock"
 */

/**
 * @param {{ version: string, fetch?: typeof fetch, document?: Document, window?: any }} options
 */
export function createCdnLoader(options) {
    const version = options.version;
    const fetchImpl = options.fetch || globalThis.fetch;
    const doc = options.document || globalThis.document;
    const win = options.window || globalThis.window;
    const loaded = {};
    let manifest = null;

    function urlFor(file) {
        return CDN_ORIGIN + '/v' + version + '/' + file;
    }

    /** @returns {Promise<ManifestEntry[]>} */
    function loadManifest() {
        if (!manifest) {
            manifest = fetchManifest().catch(function (err) {
                manifest = null;
                throw err;
            });
        }
        return manifest;
    }

    async function fetchManifest() {
        let response;
        try {
            response = await fetchImpl(urlFor('building-blocks-manifest.json'));
        } catch {
            throw new AppError('cdn_unavailable', 'The manifest for release ' + version + ' could not be fetched.');
        }
        if (!response.ok) {
            throw new AppError('cdn_unavailable', 'Release ' + version + ' has no manifest on the CDN (HTTP ' + response.status + ').');
        }
        const json = await response.json();
        return Array.isArray(json.files) ? json.files : [];
    }

    // Production bundles only, smallest first: the Dock bundle also registers
    // the contact card, but a page without the Dock should not pay for it.
    function pick(entries, matches) {
        let best = null;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.kind === 'block' && matches(entry) && (!best || entry.bytes < best.bytes)) {
                best = entry;
            }
        }
        return best;
    }

    function loadEntry(entry) {
        if (!entry.integrity) {
            return Promise.reject(new AppError('cdn_unavailable', entry.file + ' has no integrity hash, so it was not loaded.'));
        }
        if (!loaded[entry.bundle]) {
            loaded[entry.bundle] = injectScript(doc, urlFor(entry.file), entry.integrity).catch(function (err) {
                delete loaded[entry.bundle];
                throw err;
            });
        }
        return loaded[entry.bundle];
    }

    /**
     * Makes sure each custom element is defined, loading only the bundles
     * that are still missing.
     * @param {string[]} tags
     */
    async function loadElements(tags) {
        const missing = [];
        for (let i = 0; i < tags.length; i++) {
            if (!win.customElements.get(tags[i])) {
                missing.push(tags[i]);
            }
        }
        if (!missing.length) {
            return;
        }
        const entries = await loadManifest();
        const loads = [];
        for (let i = 0; i < missing.length; i++) {
            const tag = missing[i];
            const entry = pick(entries, function (e) {
                return Array.isArray(e.elements) && e.elements.includes(tag);
            });
            if (!entry) {
                throw new AppError('cdn_unavailable', 'No bundle in release ' + version + ' registers <' + tag + '>.');
            }
            loads.push(loadEntry(entry));
        }
        await Promise.all(loads);
        await Promise.all(missing.map(function (tag) {
            return win.customElements.whenDefined(tag);
        }));
    }

    /**
     * Returns window.DropCowboy[name], loading its bundle first if needed.
     * @param {string} name  e.g. "dock", "campaigns", "phoneHub"
     */
    async function loadApi(name) {
        const existing = win.DropCowboy && win.DropCowboy[name];
        if (existing) {
            return existing;
        }
        const entries = await loadManifest();
        const entry = pick(entries, function (e) {
            return Array.isArray(e.namespaces) && e.namespaces.includes('DropCowboy.' + name);
        });
        if (!entry) {
            throw new AppError('cdn_unavailable', 'No bundle in release ' + version + ' provides DropCowboy.' + name + '.');
        }
        await loadEntry(entry);
        if (!win.DropCowboy || !win.DropCowboy[name]) {
            throw new AppError('cdn_unavailable', entry.file + ' loaded but did not add DropCowboy.' + name + '.');
        }
        return win.DropCowboy[name];
    }

    return { version, urlFor, loadManifest, loadElements, loadApi };
}

/**
 * Adds <script src integrity crossorigin="anonymous">. crossorigin is
 * required: the browser only checks integrity on a CORS request.
 * @param {Document} doc
 * @param {string} src
 * @param {string} integrity
 */
export function injectScript(doc, src, integrity) {
    return new Promise(function (resolve, reject) {
        const script = doc.createElement('script');
        script.src = src;
        script.integrity = integrity;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.addEventListener('load', function () {
            resolve();
        });
        script.addEventListener('error', function () {
            script.remove();
            reject(new AppError('cdn_unavailable', src + ' failed to load or did not match its integrity hash.'));
        });
        doc.head.appendChild(script);
    });
}
