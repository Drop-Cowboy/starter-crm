import { signInScreen } from '/shared/identity.js';
import { h, show } from './dom.js';

// The screen shown instead of the CRM when your own server says nobody is
// signed in (server mode). With the passcode identity it is a one-field form;
// with any other identity it explains where the sign-in happens.

/**
 * Replaces the whole app with the sign-in screen.
 *
 * @param {{ identity: ReturnType<typeof import('/shared/identity.js').createIdentity> }} crm The object startCrm() returns.
 * @returns {void}
 */
export function showSignIn(crm) {
    const screen = signInScreen(crm.identity.current());
    const status = h('p', { class: 'signin-status', role: 'alert' });
    const children = [h('h1', null, screen.title), h('p', null, screen.message)];

    if (screen.form) {
        const input = h('input', {
            id: 'passcode',
            name: 'passcode',
            type: 'password',
            autocomplete: 'current-password',
            required: true,
            'aria-describedby': 'passcode-status'
        });
        status.id = 'passcode-status';
        const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
        const form = h('form', { class: 'signin-form' },
            h('div', { class: 'field' }, h('label', { for: 'passcode' }, 'Passcode'), input),
            submit,
            status
        );
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            status.textContent = '';
            try {
                await crm.identity.signInWithPasscode(input.value);
                location.reload();
            } catch (err) {
                status.textContent = err && err.message ? err.message : 'Sign-in failed.';
                submit.disabled = false;
                input.select();
            }
        });
        children.push(form);
    }

    const app = document.getElementById('app');
    show(app, h('main', { class: 'signin', id: 'main', tabindex: '-1' }, h('div', { class: 'signin-card' }, children)));
    app.dataset.layout = 'signin';
}
