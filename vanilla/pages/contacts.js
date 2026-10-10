import { h, icon, show } from '../dom.js';

/**
 * /contacts with nobody picked. The list itself lives beside the main
 * region (contact-list.js) and stays put while you open contacts.
 */
export function renderContacts(main) {
    show(main, h('div', { class: 'empty' },
        icon('users'),
        h('h2', null, 'Pick a contact'),
        h('p', null, 'Choose someone from the list, or add a new contact.'),
        h('a', { class: 'btn primary', href: '/contacts/new' }, icon('plus'), 'Add a contact')
    ));
}
