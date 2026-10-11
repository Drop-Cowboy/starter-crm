import { contactForm } from '../contact-form.js';
import { h, icon, show } from '../dom.js';

/** Adds a contact through the headless Contacts API, then opens it. */
export function renderNewContact(main, { crm, navigate, contactList }) {
    const form = contactForm({
        crm,
        submitLabel: 'Add contact',
        onSubmit: async (values) => {
            const result = await crm.contacts.create(values);
            contactList.refresh();
            navigate('/contacts/' + encodeURIComponent(result.contact_id) + (result.created ? '' : '?existing=1'));
        }
    });
    show(main, h('div', { class: 'page' },
        h('a', { class: 'back', href: '/contacts' }, icon('chevron-left'), 'Contacts'),
        h('header', { class: 'page-h' },
            h('h1', null, 'Add a contact'),
            h('p', { class: 'hint' }, 'Every contact needs a phone number or an email. If one already exists with the same phone or email, it is opened instead.')
        ),
        form
    ));
}
