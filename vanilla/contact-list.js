import { contactInitials, contactName, formatPhone, formatShortDate } from '/shared/format.js';
import { h, icon, show } from './dom.js';
import { errorNotice, loading } from './notice.js';

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

function contactRow(contact, selectedId) {
    const sub = [contact.company, formatPhone(contact.main_phone) || contact.email].filter(Boolean).join(' · ');
    return h('li', null,
        h('a', {
            href: '/contacts/' + encodeURIComponent(contact.id),
            'aria-label': contactName(contact),
            'aria-current': contact.id === selectedId ? 'page' : null,
            'data-contact-id': contact.id
        },
        h('span', { class: 'av', 'aria-hidden': 'true' }, contactInitials(contact)),
        h('span', { class: 'who' },
            h('span', { class: 'nm' }, contactName(contact)),
            contact.dnc ? [' ', h('span', { class: 'badge danger' }, icon('ban'), 'Do not call')] : null,
            sub ? [' ', h('span', { class: 'sub' }, sub)] : null
        ),
        h('span', { class: 'when' }, formatShortDate(contact.created_at)))
    );
}

/**
 * The contacts list beside the main region on /contacts, /contacts/new and
 * /contacts/:id. It is drawn once and kept while you move between those
 * pages, so picking a contact does not reload the list. Search, paging and
 * the rows are all the headless Contacts API.
 * @param {{ crm: object, region: HTMLElement }} options
 */
export function createContactList(options) {
    const crm = options.crm;
    const region = options.region;
    const query = { text: '', offset: 0 };
    let selectedId = null;
    let started = false;
    let latest = 0;
    let searchTimer = null;

    const live = h('div', { 'aria-live': 'polite' });
    const rows = h('ul', { class: 'rows', 'aria-label': 'Contacts', hidden: true });
    const range = h('span', { class: 'hint' });
    const previous = h('button', { type: 'button', class: 'pg', onclick: () => turn(-PAGE_SIZE) }, 'Previous');
    const next = h('button', { type: 'button', class: 'pg', onclick: () => turn(PAGE_SIZE) }, 'Next');
    const pager = h('div', { class: 'pager', hidden: true }, range, h('span', { class: 'sp' }), previous, next);

    const searchInput = h('input', {
        id: 'contact-search',
        type: 'search',
        name: 'q',
        placeholder: 'Search name, phone, email…',
        'aria-describedby': 'contact-search-hint',
        autocomplete: 'off',
        oninput: () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => search(false), SEARCH_DELAY_MS);
        }
    });
    const searchForm = h('form', { class: 'lsearch', role: 'search' },
        h('label', { class: 'visually-hidden', for: 'contact-search' }, 'Search contacts'),
        icon('search'),
        searchInput,
        h('button', { type: 'submit', class: 'visually-hidden' }, 'Search'),
        h('p', { class: 'hint', id: 'contact-search-hint' }, 'A full email or phone number finds that exact contact. Anything else searches names and other fields.')
    );
    searchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        search(true);
    });

    function search(always) {
        clearTimeout(searchTimer);
        const text = searchInput.value.trim();
        if (!always && text === query.text) {
            return;
        }
        query.text = text;
        query.offset = 0;
        load();
    }

    function turn(delta) {
        query.offset = Math.max(0, query.offset + delta);
        load();
    }

    async function load() {
        const id = ++latest;
        if (rows.hidden) {
            show(live, loading('Loading contacts…'));
        }
        try {
            const page = await crm.contacts.find(query.text, { offset: query.offset, limit: PAGE_SIZE });
            if (id === latest) {
                draw(page);
            }
        } catch (err) {
            if (id === latest) {
                rows.hidden = true;
                pager.hidden = true;
                show(live, errorNotice(err, crm));
            }
        }
    }

    function draw(page) {
        if (!page.contacts.length) {
            rows.hidden = true;
            pager.hidden = true;
            rows.replaceChildren();
            show(live, query.text
                ? h('p', { class: 'nores' }, 'No contact matches "' + query.text + '".')
                : h('p', { class: 'nores' }, 'No contacts yet. ', h('a', { href: '/contacts/new' }, 'Add a contact')));
            return;
        }
        live.replaceChildren();
        const from = query.offset + 1;
        const to = query.offset + page.contacts.length;
        show(rows, page.contacts.map((contact) => contactRow(contact, selectedId)));
        range.textContent = 'Showing ' + from + '–' + to + ' of ' + page.total;
        previous.disabled = query.offset === 0;
        next.disabled = to >= page.total;
        rows.hidden = false;
        pager.hidden = false;
    }

    show(region,
        h('div', { class: 'lh' },
            h('h1', { id: 'contacts-heading' }, 'Contacts'),
            h('a', { class: 'btn sm', href: '/contacts/new' }, icon('plus'), 'New')
        ),
        searchForm,
        live,
        rows,
        pager
    );

    return {
        /** Draws the list the first time it is shown, then keeps it. */
        start() {
            if (!started) {
                started = true;
                load();
            }
        },
        /** Marks the open contact's row, without reloading. */
        select(contactId) {
            selectedId = contactId || null;
            for (const link of rows.querySelectorAll('a[data-contact-id]')) {
                if (link.getAttribute('data-contact-id') === selectedId) {
                    link.setAttribute('aria-current', 'page');
                } else {
                    link.removeAttribute('aria-current');
                }
            }
        },
        /** Reloads the current page, after a contact was added, saved or deleted. */
        refresh() {
            if (started) {
                load();
            }
        }
    };
}
