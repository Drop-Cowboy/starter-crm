import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { contactWidgets, sessionWidgets } from '@shared/widgets.js';
import { useCrm } from './crm-context.js';

/**
 * Listens for a DOM event on the element in `ref`. Building Blocks report
 * what happened with custom events (dc-call, dc-open-contact, ...), and a
 * plain addEventListener on a ref is the clearest way to receive them.
 * @param {{ current: HTMLElement | null }} ref
 * @param {string} type
 * @param {((event: CustomEvent) => void) | undefined} handler
 */
export function useElementEvent(ref, type, handler) {
    const onEvent = useEffectEvent((event) => {
        if (handler) {
            handler(event);
        }
    });
    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return undefined;
        }
        el.addEventListener(type, onEvent);
        return () => el.removeEventListener(type, onEvent);
    }, [ref, type]);
}

function useWidgetTokenManager(connect, tags) {
    const crm = useCrm();
    const key = tags.join(' ');
    const [state, setState] = useState({ tokenManager: null, error: null });
    useEffect(() => {
        let active = true;
        connect(crm, key.split(' ')).then(
            (result) => active && setState({ tokenManager: result.tokenManager, error: null }),
            (error) => active && setState({ tokenManager: null, error })
        );
        return () => {
            active = false;
        };
    }, [connect, crm, key]);
    return state;
}

/**
 * Signs in the contacts bundle (once per page load), defines the given
 * elements, and returns the contacts token manager for them. It does not
 * need the Dock, so it works before calling is set up.
 * @param {string[]} tags
 * @returns {{ tokenManager: object | null, error: unknown }}
 */
export function useContactWidgets(tags) {
    return useWidgetTokenManager(contactWidgets, tags);
}

/**
 * Starts the Dock (once per page load), defines the given elements, and
 * returns the Dock's session token manager for them to borrow.
 * @param {string[]} tags
 * @returns {{ tokenManager: object | null, error: unknown }}
 */
export function useSessionWidgets(tags) {
    return useWidgetTokenManager(sessionWidgets, tags);
}

let widgetQueue = Promise.resolve();

function enqueue(task) {
    const run = widgetQueue.then(task);
    widgetQueue = run.catch(() => {});
    return run;
}

/**
 * Opens a bundle-driven widget into the element in `ref` once it mounts,
 * and closes it on unmount. `opener(crm, element)` resolves to a close
 * function (openCampaignHub, startPhoneHub).
 *
 * Opens and closes run one after another, never overlapping. These bundles
 * keep one hub per page, and React runs effects twice in development, so a
 * close that overlapped the second open would shut the new hub.
 * @param {{ current: HTMLElement | null }} ref
 * @param {(crm: object, element: HTMLElement) => Promise<() => void>} opener
 * @returns {{ ready: boolean, error: unknown }}
 */
export function useOpenWidget(ref, opener) {
    const crm = useCrm();
    const [state, setState] = useState({ ready: false, error: null });
    useEffect(() => {
        let active = true;
        const element = ref.current;
        const opened = enqueue(() => opener(crm, element));
        opened.then(
            () => active && setState({ ready: true, error: null }),
            (error) => active && setState({ ready: false, error })
        );
        return () => {
            active = false;
            enqueue(() => opened.then((close) => close(), () => {}));
        };
    }, [ref, opener, crm]);
    return state;
}

export function usePageTitle(title) {
    useEffect(() => {
        document.title = title + ' · Starter CRM';
    }, [title]);
}

/**
 * Whether a CSS media query matches now, updated as the window changes.
 * @param {string} query
 * @returns {boolean}
 */
export function useMediaQuery(query) {
    const subscribe = useCallback((onChange) => {
        if (typeof window.matchMedia !== 'function') {
            return () => {};
        }
        const list = window.matchMedia(query);
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
    }, [query]);
    return useSyncExternalStore(subscribe, () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
}

/**
 * Shows the <dialog> in the returned ref as a modal while `open` is true.
 * When it closes, focus goes back to the control that opened it.
 * @param {boolean} open
 */
export function useModalDialog(open) {
    const ref = useRef(null);
    const opener = useRef(null);
    useEffect(() => {
        const dialog = ref.current;
        if (open) {
            if (!dialog.open) {
                opener.current = document.activeElement;
                dialog.showModal();
            }
            return;
        }
        if (dialog.open) {
            dialog.close();
        }
        const back = opener.current;
        opener.current = null;
        if (back && back.isConnected) {
            back.focus();
        }
    }, [open]);
    return ref;
}

/** Everything in the activity log, newest first, kept current. */
export function useActivityItems() {
    const crm = useCrm();
    return useSyncExternalStore(crm.activity.subscribe, crm.activity.items);
}
