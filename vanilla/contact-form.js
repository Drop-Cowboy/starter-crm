import { FIELD_INPUTS } from '/shared/contacts-api.js';
import { h, show } from './dom.js';
import { errorNotice } from './notice.js';

let formCount = 0;

/**
 * A labelled form for the standard contact fields. Errors from onSubmit are
 * explained inside the form, next to what the user was doing.
 * @param {{
 *   crm: object,
 *   values?: Record<string, string>,
 *   submitLabel: string,
 *   onSubmit: (values: Record<string, string>) => Promise<void>
 * }} options
 */
export function contactForm(options) {
    const id = 'contact-form-' + (++formCount);
    const values = options.values || {};
    const errors = h('div');
    const status = h('p', { class: 'hint', role: 'status' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, options.submitLabel);

    const fields = FIELD_INPUTS.map((field) => h('div', { class: 'field' },
        h('label', { for: id + '-' + field.name }, field.label),
        h('input', {
            id: id + '-' + field.name,
            name: field.name,
            type: field.type,
            autocomplete: field.autocomplete,
            value: values[field.name] || ''
        })
    ));

    const form = h('form', { class: 'card', novalidate: true },
        errors,
        h('div', { class: 'form-grid' }, fields),
        h('div', { class: 'actions' }, submit, status)
    );

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = 'Saving…';
        errors.replaceChildren();
        try {
            await options.onSubmit(Object.fromEntries(new FormData(form)));
        } catch (err) {
            show(errors, errorNotice(err, options.crm));
        } finally {
            submit.disabled = false;
            status.textContent = '';
        }
    });
    return form;
}
