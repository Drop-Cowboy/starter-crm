import { CONSENT_METHOD_LABELS, CONSENT_METHODS } from '/shared/contacts-api.js';
import { h, show } from './dom.js';
import { errorNotice } from './notice.js';

/**
 * Records consent a contact gave you outside Drop Cowboy, so calls and texts
 * to them pass the consent check. Errors are explained inside the form.
 * @param {{
 *   crm: object,
 *   labelledBy: string,
 *   getContact: () => { id: string, main_phone: string },
 *   onCancel: () => void,
 *   onRecorded: () => void
 * }} options
 */
export function consentForm(options) {
    const errors = h('div');
    const status = h('p', { class: 'hint', role: 'status' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Record consent');

    const methodOptions = CONSENT_METHODS.map((m) => h('option', { value: m }, CONSENT_METHOD_LABELS[m]));

    const form = h('form', { class: 'sheet-b', 'aria-labelledby': options.labelledBy, novalidate: true },
        h('p', { class: 'note' }, 'Only record consent the contact actually gave you. Opt-outs, STOP replies and Do Not Call still block.'),
        errors,
        h('fieldset', null,
            h('legend', null, 'They agreed to'),
            h('label', null, h('input', { type: 'checkbox', name: 'channels', value: 'sms' }), ' Texts'),
            h('label', null, h('input', { type: 'checkbox', name: 'channels', value: 'calls' }), ' Calls')
        ),
        h('div', { class: 'field' },
            h('label', { for: 'consent-method' }, 'How they agreed'),
            h('select', { id: 'consent-method', name: 'consent_method' }, methodOptions)
        ),
        h('div', { class: 'field' },
            h('label', { for: 'consent-text' }, 'What they agreed to'),
            h('textarea', { id: 'consent-text', name: 'consent_text', rows: 3, placeholder: 'The exact wording, for example: I agree to receive texts from Example Co. Reply STOP to opt out.' })
        ),
        h('div', { class: 'actions' },
            submit,
            h('button', { type: 'button', class: 'btn sec', onclick: () => options.onCancel() }, 'Cancel'),
            status
        )
    );

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        submit.disabled = true;
        status.textContent = 'Recording…';
        errors.replaceChildren();
        try {
            const contact = options.getContact();
            await options.crm.contacts.recordConsent(contact.id, {
                phone_number: contact.main_phone,
                channels: data.getAll('channels'),
                consent_method: data.get('consent_method'),
                consent_text: data.get('consent_text')
            });
            form.reset();
            options.onRecorded();
        } catch (err) {
            show(errors, errorNotice(err, options.crm));
        } finally {
            submit.disabled = false;
            status.textContent = '';
        }
    });
    return form;
}
