// A History API router: real paths like /contacts/5a4b3c2d-..., no #.
// The starter server answers any unknown page path with index.html, so a
// reload or a pasted link lands back here and the router picks the page.

import { readLayout } from '/shared/ui.js';

/**
 * @typedef {{ path: string, title: string, render: (main: HTMLElement, ctx: object) => (void | (() => void) | Promise<void | (() => void)>) }} Route
 */

function match(pattern, path) {
    const want = pattern.split('/');
    const got = path.split('/');
    if (want.length !== got.length) {
        return null;
    }
    const params = {};
    for (let i = 0; i < want.length; i++) {
        if (want[i].startsWith(':')) {
            params[want[i].slice(1)] = decodeURIComponent(got[i]);
        } else if (want[i] !== got[i]) {
            return null;
        }
    }
    return params;
}

// ?layout=embedded previews the app inside a page of your own app. It stays
// on as you navigate, until a URL sets layout to something else.
function keepLayout(path) {
    if (readLayout(location.search) !== 'embedded') {
        return path;
    }
    const url = new URL(path, location.origin);
    if (!url.searchParams.has('layout')) {
        url.searchParams.set('layout', 'embedded');
    }
    return url.pathname + url.search;
}

/**
 * @param {{
 *   routes: Route[],
 *   main: HTMLElement,
 *   context: object,
 *   onChange?: (path: string, route: Route) => void,
 *   onError: (err: unknown, main: HTMLElement) => void
 * }} options
 */
export function createRouter(options) {
    let cleanup = null;
    let renderId = 0;

    async function render() {
        const path = location.pathname.replace(/\/+$/, '') || '/';
        let route = null;
        let params = {};
        for (const candidate of options.routes) {
            const found = match(candidate.path, path);
            if (found) {
                route = candidate;
                params = found;
                break;
            }
        }
        route = route || options.routes[options.routes.length - 1];

        if (cleanup) {
            cleanup();
            cleanup = null;
        }
        const id = ++renderId;
        document.title = route.title + ' · Starter CRM';
        options.main.replaceChildren();
        if (options.onChange) {
            options.onChange(path, route);
        }
        const ctx = Object.assign({ params, navigate, isCurrent: () => id === renderId }, options.context);
        let result;
        try {
            result = await route.render(options.main, ctx);
        } catch (err) {
            if (id === renderId) {
                options.onError(err, options.main);
            }
        }
        if (id !== renderId) {
            if (typeof result === 'function') {
                result();
            }
            return;
        }
        cleanup = typeof result === 'function' ? result : null;
        // Move focus to the new page, as a full page load would, so screen
        // readers announce it and keyboard users start at the top.
        options.main.focus();
    }

    function navigate(path) {
        const target = keepLayout(path);
        if (target !== location.pathname + location.search) {
            history.pushState(null, '', target);
        }
        return render();
    }

    // Same-origin links navigate without a page load. Modified clicks
    // (new tab, download) and external links are left to the browser.
    document.addEventListener('click', (event) => {
        const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
        }
        const url = new URL(link.href);
        if (url.origin !== location.origin || link.target || link.hasAttribute('download') || url.pathname.startsWith('/react/')) {
            return;
        }
        event.preventDefault();
        if (url.pathname === location.pathname && url.hash) {
            location.hash = url.hash;
            return;
        }
        navigate(url.pathname + url.search).then(() => {
            if (url.hash) {
                const target = document.getElementById(url.hash.slice(1));
                if (target) {
                    target.scrollIntoView();
                }
            }
        });
    });
    window.addEventListener('popstate', render);

    return { start: render, navigate };
}
