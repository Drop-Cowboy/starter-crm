import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cdnVersionFor, DEFAULT_CDN_VERSION } from '../config.js';
import { createCdnLoader } from '../dropcowboy-cdn.js';
import { jsonResponse, scriptedFetch } from './helpers.js';

const MANIFEST = {
    files: [
        { file: 'dropcowboy-dock.js', bundle: 'dock', kind: 'block', bytes: 500, integrity: 'sha384-dock', elements: ['dc-dock', 'dc-contact-card', 'dc-pipeline-board'], namespaces: ['DropCowboy.dock'] },
        { file: 'dropcowboy-contacts.js', bundle: 'contacts', kind: 'block', bytes: 120, integrity: 'sha384-contacts', elements: ['dc-contact-card', 'dc-pipeline-board'], namespaces: ['DropCowboy.contacts'] },
        { file: 'dropcowboy-contact-hub.js', bundle: 'contacts', kind: 'block', bytes: 120, integrity: 'sha384-contacts', elements: ['dc-contact-card', 'dc-pipeline-board'], namespaces: ['DropCowboy.contacts'] },
        { file: 'dropcowboy-dialer-playground.js', bundle: 'dialer-playground', kind: 'playground', bytes: 10, integrity: 'sha384-play', elements: ['dc-softphone'], namespaces: [] },
        { file: 'dropcowboy-phone-hub.js', bundle: 'phone-hub', kind: 'block', bytes: 100, integrity: '', elements: ['dc-phone-hub'], namespaces: ['DropCowboy.phoneHub'] }
    ]
};

// A document whose <script> elements "load" when appended, running onLoad.
function fakePage(onLoad) {
    const defined = new Set();
    const scripts = [];
    const win = {
        DropCowboy: {},
        customElements: {
            get: (tag) => (defined.has(tag) ? class {} : undefined),
            whenDefined: async () => undefined
        }
    };
    const doc = {
        createElement: () => {
            const listeners = {};
            return {
                addEventListener: (name, fn) => {
                    listeners[name] = fn;
                },
                remove() {},
                fire: (name) => listeners[name](),
                listeners
            };
        },
        head: {
            appendChild: (script) => {
                scripts.push(script);
                queueMicrotask(() => {
                    const ok = onLoad(script, win, defined);
                    script.fire(ok === false ? 'error' : 'load');
                });
            }
        }
    };
    return { win, doc, scripts, defined };
}

function defineFrom(manifest) {
    return function (script, win, defined) {
        const entry = manifest.files.find((f) => script.src.endsWith('/' + f.file));
        for (const tag of entry.elements) {
            defined.add(tag);
        }
        for (const ns of entry.namespaces) {
            win.DropCowboy[ns.split('.')[1]] = { name: ns };
        }
    };
}

function loaderFor(page, fetch) {
    return createCdnLoader({ version: '3.33.0', fetch, document: page.doc, window: page.win });
}

describe('CDN loader', () => {
    it('injects the pinned file with its integrity hash and crossorigin', async () => {
        const page = fakePage(defineFrom(MANIFEST));
        const fetch = scriptedFetch([() => jsonResponse(200, MANIFEST)]);
        await loaderFor(page, fetch).loadElements(['dc-contact-card']);

        assert.equal(fetch.calls[0].url, 'https://webforms.dropcowboy.com/v3.33.0/building-blocks-manifest.json');
        assert.equal(page.scripts.length, 1);
        const script = page.scripts[0];
        assert.equal(script.src, 'https://webforms.dropcowboy.com/v3.33.0/dropcowboy-contacts.js');
        assert.equal(script.integrity, 'sha384-contacts');
        assert.equal(script.crossOrigin, 'anonymous');
    });

    it('loads a bundle once even when two tags share it', async () => {
        const page = fakePage(defineFrom(MANIFEST));
        const loader = loaderFor(page, scriptedFetch([() => jsonResponse(200, MANIFEST)]));
        await Promise.all([loader.loadElements(['dc-contact-card', 'dc-pipeline-board']), loader.loadElements(['dc-pipeline-board'])]);
        assert.equal(page.scripts.length, 1);
    });

    it('skips elements that are already defined', async () => {
        const page = fakePage(defineFrom(MANIFEST));
        page.defined.add('dc-contact-card');
        const fetch = scriptedFetch([]);
        await loaderFor(page, fetch).loadElements(['dc-contact-card']);
        assert.equal(fetch.calls.length, 0);
        assert.equal(page.scripts.length, 0);
    });

    it('finds an API namespace and never picks a playground bundle', async () => {
        const page = fakePage(defineFrom(MANIFEST));
        const loader = loaderFor(page, scriptedFetch([() => jsonResponse(200, MANIFEST)]));
        const dock = await loader.loadApi('dock');
        assert.equal(dock.name, 'DropCowboy.dock');
        assert.equal(page.scripts[0].integrity, 'sha384-dock');
        await assert.rejects(loader.loadElements(['dc-softphone']), { code: 'cdn_unavailable' });
    });

    it('refuses an entry without an integrity hash', async () => {
        const page = fakePage(defineFrom(MANIFEST));
        const loader = loaderFor(page, scriptedFetch([() => jsonResponse(200, MANIFEST)]));
        await assert.rejects(loader.loadApi('phoneHub'), { code: 'cdn_unavailable' });
        assert.equal(page.scripts.length, 0);
    });

    it('reports a script that fails integrity, and can retry it', async () => {
        let fail = true;
        const page = fakePage((script, win, defined) => {
            if (fail) {
                fail = false;
                return false;
            }
            return defineFrom(MANIFEST)(script, win, defined);
        });
        const loader = loaderFor(page, scriptedFetch([() => jsonResponse(200, MANIFEST)]));
        await assert.rejects(loader.loadElements(['dc-contact-card']), { code: 'cdn_unavailable' });
        await loader.loadElements(['dc-contact-card']);
        assert.equal(page.scripts.length, 2);
    });

    it('reports a release with no manifest, and fetches again next time', async () => {
        const page = fakePage(defineFrom(MANIFEST));
        const fetch = scriptedFetch([() => new Response('Forbidden', { status: 403 }), () => jsonResponse(200, MANIFEST)]);
        const loader = loaderFor(page, fetch);
        await assert.rejects(loader.loadElements(['dc-contact-card']), { code: 'cdn_unavailable' });
        await loader.loadElements(['dc-contact-card']);
        assert.equal(fetch.calls.length, 2);
    });
});

describe('cdnVersionFor', () => {
    it('uses the pinned default, strips a leading v, and refuses "latest"', () => {
        assert.equal(cdnVersionFor({ cdn_version: null }), DEFAULT_CDN_VERSION);
        assert.equal(DEFAULT_CDN_VERSION, '3.33.6');
        assert.equal(cdnVersionFor({ cdn_version: 'v3.34.1' }), '3.34.1');
        assert.throws(() => cdnVersionFor({ cdn_version: 'latest' }), { code: 'invalid_cdn_version' });
    });
});
