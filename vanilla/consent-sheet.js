import { consentForm } from './consent-form.js';
import { h, icon } from './dom.js';

/**
 * The consent form in a side sheet: a modal <dialog>, so Esc closes it and
 * the rest of the page waits. Focus goes back to whatever opened it. The
 * form inside is fresh each time it opens.
 * @param {{ crm: object, getContact: () => object, onRecorded: () => void }} options
 */
export function consentSheet(options) {
    const forName = h('p', { class: 'hint' });
    let opener = null;
    let form = null;

    const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'consent-sheet-title' },
        h('div', { class: 'sheet-h' },
            h('span', { class: 'si', 'aria-hidden': 'true' }, icon('shield')),
            h('div', null, h('h2', { id: 'consent-sheet-title' }, 'Record consent'), forName),
            h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('x'))
        )
    );
    dialog.addEventListener('close', () => {
        if (form) {
            form.remove();
            form = null;
        }
        if (opener && opener.isConnected) {
            opener.focus();
        }
        opener = null;
    });

    return {
        element: dialog,
        /** @param {string} name   the contact's name, for the sheet's header */
        open(name) {
            opener = document.activeElement;
            forName.textContent = 'for ' + name;
            form = consentForm({
                crm: options.crm,
                labelledBy: 'consent-sheet-title',
                getContact: options.getContact,
                onCancel: () => dialog.close(),
                onRecorded: () => {
                    dialog.close();
                    options.onRecorded();
                }
            });
            dialog.appendChild(form);
            dialog.showModal();
            form.querySelector('input').focus();
        }
    };
}
