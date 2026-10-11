import { explainError, explainPageError } from '/shared/errors.js';
import { h, icon } from './dom.js';

/**
 * A plain-language explanation of an error, with the fix link and a
 * "Sign in" button when signing in is the fix. Inside a page it is short for
 * a refusal the app banner already explains; pass { full: true } for the
 * banner itself, or where there is no banner.
 * @param {unknown} err
 * @param {{ login?: { signIn(returnTo: string): Promise<void> } | null }} crm
 * @param {{ full?: boolean }} [options]
 */
export function errorNotice(err, crm, options) {
    const g = options && options.full ? explainError(err) : explainPageError(err);
    const signIn = g.action === 'sign_in' && crm.login && crm.login.isConfigured()
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => crm.login.signIn(location.pathname) }, 'Sign in with Drop Cowboy')
        : null;
    const link = g.link ? h('a', { href: g.link.href }, g.link.label) : null;
    return h('div', { class: 'notice error', role: 'alert' },
        h('h2', null, g.title),
        h('p', null, g.message),
        (signIn || link) ? h('div', { class: 'actions' }, signIn, link) : null
    );
}

/** The app-wide warning strip under the top bar, with a dismiss button. */
export function bannerNotice(err, crm, onDismiss) {
    return h('div', { class: 'banner' },
        h('span', { class: 'bi', 'aria-hidden': 'true' }, icon('alert')),
        errorNotice(err, crm, { full: true }),
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Dismiss notice', onclick: onDismiss }, icon('x'))
    );
}

export function infoNotice(title, message) {
    return h('div', { class: 'notice info' }, h('h2', null, title), h('p', null, message));
}

export function loading(label) {
    return h('p', { class: 'hint', role: 'status' }, label || 'Loading…');
}
