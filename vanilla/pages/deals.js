import { DEAL_STAGES, archivedNote, createDealsApi, dealsAvailable, formatAmount, parseAmount, stageLabel } from '/shared/deals-api.js';
import { AppError } from '/shared/errors.js';
import { contactName } from '/shared/format.js';
import { connectContactWidget, contactWidgets } from '/shared/widgets.js';
import { toast } from '../activity.js';
import { h, icon, show } from '../dom.js';
import { errorNotice, infoNotice, loading } from '../notice.js';
import { page, widgetFrame } from '../page.js';

const api = createDealsApi();

/** The contacts a deal can be linked to: the newest hundred. A bigger team would search instead. */
async function loadContacts(crm) {
    try {
        return (await crm.contacts.list({ limit: 100 })).contacts;
    } catch {
        return [];
    }
}

/** A name for each contact id the deals mention, or null for one Drop Cowboy no longer has. */
async function loadNames(crm, deals, names) {
    const wanted = [...new Set(deals.map((deal) => deal.contact_id).filter((id) => id && !names.has(id)))];
    await Promise.all(wanted.map(async (id) => {
        try {
            const contact = await crm.contacts.get(id);
            names.set(id, contact ? contactName(contact) : null);
        } catch {
            names.set(id, undefined);
        }
    }));
}

/**
 * Deals: the example of a module of your own. The deals live on this server (not in Drop Cowboy) and each can point at
 * a contact, whose card opens below the list. The routes and the data they keep are in each server's modules/deals.
 */
export async function renderDeals(main, { crm, isCurrent }) {
    if (!dealsAvailable(crm.config)) {
        show(main, page('Deals', null, infoNotice('Deals need server mode',
            'Modules keep their data for a signed-in user, so they run when DC_AUTH_MODE=server. Set it in .env and restart.')));
        return undefined;
    }

    const names = new Map();
    const state = { stage: '', showArchived: false, deals: [], contacts: [], openId: null };
    const problems = h('div', { class: 'problems' });
    const list = h('div', { class: 'deal-list' }, loading('Loading deals…'));
    const detail = h('div', { class: 'deal-detail' });

    async function run(action) {
        problems.replaceChildren();
        try {
            await action();
        } catch (err) {
            show(problems, errorNotice(err, crm));
        }
    }

    async function refresh() {
        const filter = { archived: state.showArchived ? 'all' : false };
        if (state.stage) {
            filter.stage = state.stage;
        }
        state.deals = await api.list(filter);
        await loadNames(crm, state.deals, names);
        if (isCurrent()) {
            draw();
        }
    }

    function contactLabel(deal) {
        if (!deal.contact_id) {
            return null;
        }
        const name = names.get(deal.contact_id);
        if (name) {
            return h('a', { href: '/contacts/' + encodeURIComponent(deal.contact_id) }, icon('user'), name);
        }
        return h('span', { class: 'hint' }, name === null ? 'Contact deleted' : 'Contact ' + deal.contact_id.slice(0, 8));
    }

    function stageSelect(deal) {
        const select = h('select', { 'aria-label': 'Stage for ' + deal.title },
            DEAL_STAGES.map((stage) => h('option', { value: stage.id, selected: stage.id === deal.stage }, stage.label)));
        select.addEventListener('change', () => run(async () => {
            await api.update(deal.id, { stage: select.value });
            toast(deal.title + ' is now ' + stageLabel(select.value));
            await refresh();
        }));
        return select;
    }

    function row(deal) {
        const note = archivedNote(deal);
        return h('article', { class: deal.archived ? 'deal archived' : 'deal', 'data-deal-id': deal.id },
            h('div', { class: 'deal-main' },
                h('h2', null, deal.title),
                h('p', { class: 'deal-meta' }, formatAmount(deal.amount_cents, deal.currency), ' ', contactLabel(deal)),
                note ? h('p', { class: 'deal-note' }, h('span', { class: 'badge' }, note)) : null,
                deal.notes ? h('p', { class: 'hint' }, deal.notes) : null
            ),
            h('div', { class: 'deal-acts' },
                stageSelect(deal),
                deal.contact_id && names.get(deal.contact_id)
                    ? h('button', { type: 'button', class: 'btn sm', onclick: () => openContact(deal) }, icon('user'), 'Contact card')
                    : null,
                h('button', {
                    type: 'button',
                    class: 'btn sm',
                    onclick: () => run(async () => {
                        await api.update(deal.id, { archived: !deal.archived });
                        await refresh();
                    })
                }, deal.archived ? 'Restore' : 'Archive'),
                h('button', {
                    type: 'button',
                    class: 'btn sm danger-o',
                    'aria-label': 'Delete ' + deal.title,
                    onclick: () => run(async () => {
                        await api.remove(deal.id);
                        if (state.openId === deal.id) {
                            state.openId = null;
                            detail.replaceChildren();
                        }
                        toast('Deleted ' + deal.title);
                        await refresh();
                    })
                }, icon('trash'), 'Delete')
            )
        );
    }

    function draw() {
        if (state.deals.length === 0) {
            show(list, h('div', { class: 'empty' }, icon('briefcase'),
                h('h2', null, state.stage || state.showArchived ? 'No deals match' : 'No deals yet'),
                h('p', null, 'Add a deal above. Link it to a contact to see their card here.')));
            return;
        }
        show(list, state.deals.map(row));
    }

    async function openContact(deal) {
        state.openId = deal.id;
        const status = loading('Loading contact card…');
        show(detail, widgetFrame('dc-contact-card', { tag: 'section', attrs: { 'aria-label': 'Contact card for ' + deal.title } }, status));
        try {
            const { tokenManager } = await contactWidgets(crm, ['dc-contact-card']);
            if (!isCurrent() || state.openId !== deal.id) {
                return;
            }
            const card = document.createElement('dc-contact-card');
            card.className = 'widget';
            connectContactWidget(card, crm, tokenManager);
            card.contactId = deal.contact_id;
            status.replaceWith(card);
        } catch (err) {
            status.replaceWith(errorNotice(err, crm));
        }
    }

    const contactSelect = h('select', { id: 'deal-contact', name: 'contact_id' }, h('option', { value: '' }, 'No contact'));
    const form = h('form', { class: 'card', novalidate: true, 'aria-label': 'Add a deal' },
        h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', { for: 'deal-title' }, 'Title'), h('input', { id: 'deal-title', name: 'title', required: true, maxlength: 200 })),
            h('div', { class: 'field' }, h('label', { for: 'deal-amount' }, 'Amount (USD)'), h('input', { id: 'deal-amount', name: 'amount', inputmode: 'decimal', placeholder: '0.00' })),
            h('div', { class: 'field' }, h('label', { for: 'deal-stage' }, 'Stage'),
                h('select', { id: 'deal-stage', name: 'stage' }, DEAL_STAGES.map((stage) => h('option', { value: stage.id }, stage.label)))),
            h('div', { class: 'field' }, h('label', { for: 'deal-contact' }, 'Contact'), contactSelect)
        ),
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary' }, icon('plus-square'), 'Add deal'))
    );
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        run(async () => {
            const values = Object.fromEntries(new FormData(form));
            const amount = parseAmount(values.amount);
            if (amount === null) {
                throw new AppError('invalid_request', 'amount: enter a number such as 1250 or 1250.50.');
            }
            const body = { title: String(values.title || '').trim(), amount_cents: amount, stage: values.stage };
            if (values.contact_id) {
                body.contact_id = values.contact_id;
            }
            const deal = await api.create(body);
            form.reset();
            toast('Added ' + deal.title);
            await refresh();
        });
    });

    const stageFilter = h('select', { id: 'deal-filter-stage', 'aria-label': 'Filter by stage' },
        h('option', { value: '' }, 'All stages'),
        DEAL_STAGES.map((stage) => h('option', { value: stage.id }, stage.label)));
    const archivedToggle = h('input', { type: 'checkbox', id: 'deal-show-archived' });
    stageFilter.addEventListener('change', () => {
        state.stage = stageFilter.value;
        run(refresh);
    });
    archivedToggle.addEventListener('change', () => {
        state.showArchived = archivedToggle.checked;
        run(refresh);
    });

    show(main, page('Deals', 'What you are selling, kept on this server and linked to Drop Cowboy contacts. A deleted contact archives its deals.',
        problems,
        form,
        h('div', { class: 'deal-filters' }, stageFilter, h('label', { for: 'deal-show-archived' }, archivedToggle, 'Show archived')),
        list,
        detail
    ));

    // A contact deleted in Drop Cowboy archives its deals on the server; reload when that webhook arrives.
    const seen = new Set(crm.activity.items().map((item) => item.id));
    const unsubscribe = crm.activity.subscribe((items) => {
        const fresh = items.filter((item) => !seen.has(item.id));
        for (const item of items) {
            seen.add(item.id);
        }
        if (fresh.some((item) => item.event === 'contact.deleted' && !item.replayed)) {
            // Archiving happens right after the webhook is recorded, so give the server a moment.
            setTimeout(() => run(refresh), 800);
        }
    });

    await run(refresh);
    loadContacts(crm).then((contacts) => {
        if (!isCurrent()) {
            return;
        }
        state.contacts = contacts;
        for (const contact of contacts) {
            contactSelect.appendChild(h('option', { value: contact.id }, contactName(contact)));
        }
    });
    return unsubscribe;
}
