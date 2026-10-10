import { createContext, useCallback, useContext } from 'react';

/**
 * Adds layout=embedded to an in-app path when the app is embedded, so every
 * link and navigation stays embedded.
 * @param {string} path
 * @param {'full' | 'embedded'} layout
 */
export function withLayout(path, layout) {
    if (layout !== 'embedded') {
        return path;
    }
    const hashAt = path.indexOf('#');
    const hash = hashAt === -1 ? '' : path.slice(hashAt);
    const rest = hashAt === -1 ? path : path.slice(0, hashAt);
    const queryAt = rest.indexOf('?');
    const pathname = queryAt === -1 ? rest : rest.slice(0, queryAt);
    const params = new URLSearchParams(queryAt === -1 ? '' : rest.slice(queryAt + 1));
    params.set('layout', 'embedded');
    return pathname + '?' + params + hash;
}

/**
 * What pages share with the app shell: the layout, a way to tell the
 * contacts list to reload, the contact facts for the context panel, and the
 * context panel's state for the contact page's panel button.
 */
export const LayoutContext = createContext({
    layout: 'full',
    contactsVersion: 0,
    contactsChanged: () => {},
    setContactFacts: () => {},
    context: 'closed',
    toggleRail: () => {}
});

export function useLayout() {
    return useContext(LayoutContext);
}

/** @returns {(path: string) => string} the path, keeping the current layout */
export function useAppPath() {
    const { layout } = useLayout();
    return useCallback((path) => withLayout(path, layout), [layout]);
}
