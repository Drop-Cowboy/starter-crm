import { changedFields } from '/shared/contacts-api.js';
import { contactInitials, contactName, formatDate, formatPhone } from '/shared/format.js';
import { contactSandboxHint } from '/shared/sandbox.js';
import { callContact, connectContactWidget, contactWidgets, focusContact, textContact } from '/shared/widgets.js';
import { activityItem, toast } from '../activity.js';
import { consentSheet } from '../consent-sheet.js';
import { contactForm } from '../contact-form.js';
import { h, icon, show } from '../dom.js';
import { errorNotice, infoNotice, loading } from '../notice.js';
import { widgetFrame } from '../page.js';
import { createTabs } from '../tabs.js';

function deleteDialog(contact, onConfirm) {
    const cancel = h('button', { type: 'button', class: 'btn sec', autofocus: true }, 'Cancel');
    const confirm = h('button', { type: 'button', class: 'btn danger' }, 'Delete contact');
    const dialog = h('dialog', { class: 'dlg', 'aria-labelledby': 'delete-title' },
        h('h2', { id: 'delete-title' }, 'Delete ' + contactName(contact) + '?'),
        h('p', null, 'The contact is removed from Drop Cowboy. This cannot be undone here.'),
        h('div', { class: 'actions' }, cancel, confirm)
    );
    cancel.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => {
        dialog.close();
        onConfirm();
    });
    dialog.addEventListener('close', () => dialog.remove());
    return dialog;
}

function profileInfo(contact) {
    const hasSubline = contact.company || contact.main_phone || contact.email;
    return h('div', { class: 'pinfo' },
        h('h1', null, contactName(contact), contact.dnc ? [' ', h('span', { class: 'badge danger' }, icon('ban'), 'Do not call')] : null),
        hasSubline ? h('p', { class: 'subline' },
            contact.company ? h('span', null, icon('building'), contact.company) : null,
            contact.main_phone ? [' ', h('a', { href: 'tel:' + contact.main_phone }, icon('phone'), formatPhone(contact.main_phone))] : null,
            contact.email ? [' ', h('a', { href: 'mailto:' + contact.email }, icon('mail'), contact.email)] : null
        ) : null,
        h('p', { class: 'meta' },
            contact.created_at ? [h('span', null, icon('calendar'), 'Created ' + formatDate(contact.created_at)), ' '] : null,
            h('span', null, icon('ban'), 'Do not call: ' + (contact.dnc ? 'On list' : 'Not listed'))
        )
    );
}

/**
 * One contact: the editable fields come from the REST API, and the Drop
 * Cowboy contact card (with its activity timeline) shows what happened with
 * them. Call and Text hand the contact to the Dock.
 */
export async function renderContact(main, { crm, params, navigate, isCurrent, shell, contactList }) {
    show(main, h('div', { class: 'page' }, loading('Loading contact…')));
    let contact = await crm.contacts.get(params.id);
    if (!isCurrent()) {
        return undefined;
    }
    if (!contact) {
        show(main, h('div', { class: 'page' },
            h('h1', null, 'Contact not found'),
            h('p', null, 'No contact has that id. It may have been deleted.'),
            h('a', { href: '/contacts' }, 'Back to contacts')
        ));
        return undefined;
    }
    document.title = contactName(contact) + ' · Starter CRM';

    const avatar = h('span', { class: 'av lg', 'aria-hidden': 'true' }, contactInitials(contact));
    let info = profileInfo(contact);
    const problems = h('div', { class: 'problems' });
    const card = document.createElement('dc-contact-card');
    card.className = 'widget';
    const cardStatus = loading('Loading contact card…');

    async function run(action) {
        problems.replaceChildren();
        try {
            await action();
        } catch (err) {
            show(problems, errorNotice(err, crm));
        }
    }

    // The card reloads when its contactId changes, so bounce it.
    function reloadCard() {
        card.contactId = '';
        card.contactId = contact.id;
    }

    function confirmDelete() {
        const dialog = deleteDialog(contact, () => run(async () => {
            await crm.contacts.remove(contact.id);
            contactList.refresh();
            toast('Deleted ' + contactName(contact));
            navigate('/contacts');
        }));
        document.body.appendChild(dialog);
        dialog.showModal();
    }

    const sheet = consentSheet({
        crm,
        getContact: () => contact,
        onRecorded: () => {
            reloadCard();
            toast('Recorded consent for ' + contactName(contact));
        }
    });
    const openSheet = () => sheet.open(contactName(contact));

    const form = contactForm({
        crm,
        values: contact,
        submitLabel: 'Save changes',
        onSubmit: async (values) => {
            contact = await crm.contacts.update(contact.id, changedFields(contact, values));
            const next = profileInfo(contact);
            info.replaceWith(next);
            info = next;
            avatar.textContent = contactInitials(contact);
            document.title = contactName(contact) + ' · Starter CRM';
            drawSandboxHint();
            shell.setContact(contact);
            reloadCard();
            contactList.refresh();
            toast('Saved ' + contactName(contact));
        }
    });

    // This contact's share of the live activity log, as it arrives.
    const feed = h('ol', { class: 'feed', 'aria-label': 'Activity for ' + contactName(contact) });
    const feedEmpty = h('p', { class: 'feed-empty' }, 'Nothing yet for ' + contactName(contact) + '. Calls, texts and consent changes appear here as they happen.');
    function drawFeed(items) {
        const mine = items.filter((item) => item.contactId === contact.id);
        show(feed, mine.map(activityItem));
        feed.hidden = mine.length === 0;
        feedEmpty.hidden = mine.length > 0;
    }
    drawFeed(crm.activity.items());
    const unsubscribe = crm.activity.subscribe((items) => drawFeed(items));

    const tabs = createTabs({
        label: 'Contact sections',
        items: [
            {
                id: 'overview',
                label: 'Overview',
                content: widgetFrame('dc-contact-card', { tag: 'section', attrs: { 'aria-label': 'Drop Cowboy contact card' } }, cardStatus)
            },
            {
                id: 'activity',
                label: 'Activity',
                content: [feed, feedEmpty, h('p', { class: 'hint' }, 'The full history is in the timeline on the Overview tab.')]
            },
            {
                id: 'consent',
                label: 'Consent',
                content: h('section', { class: 'card cta-card', 'aria-labelledby': 'consent-tab-heading' },
                    h('h2', { id: 'consent-tab-heading' }, 'Consent'),
                    h('p', null, 'Texts and calls to US numbers need consent on record, unless your team turned on "Use existing '
                        + 'contact consent" in Drop Cowboy. Opt-outs, STOP replies and Do Not Call always block, whatever is recorded.'),
                    h('button', { type: 'button', class: 'btn primary', onclick: openSheet }, icon('shield'), 'Record consent')
                )
            },
            {
                id: 'edit',
                label: 'Edit',
                content: [
                    h('h2', null, 'Edit details'),
                    form,
                    h('section', { class: 'card danger-zone', 'aria-labelledby': 'danger-zone-heading' },
                        h('h2', { id: 'danger-zone-heading' }, 'Danger zone'),
                        h('div', { class: 'dz-row' },
                            h('p', null, 'Delete this contact from Drop Cowboy. This cannot be undone here.'),
                            h('button', { type: 'button', class: 'btn danger-o', onclick: confirmDelete }, icon('trash'), 'Delete contact')
                        )
                    )
                ]
            }
        ]
    });

    const reachable = Boolean(contact.main_phone);
    const existed = new URLSearchParams(location.search).get('existing') === '1';
    // In sandbox mode (readiness says sandbox_only) a sentence under the
    // buttons says what Call and Text will really do: a 555 test number is
    // answered by Drop Cowboy's test line, anything else is refused. Outside
    // sandbox mode it stays hidden and empty.
    const sandboxHint = h('p', { class: 'hint', id: 'sandbox-hint', hidden: true });
    const callButton = h('button', { type: 'button', class: 'btn primary', disabled: !reachable, onclick: () => run(() => callContact(crm, contact)) }, icon('phone'), 'Call');
    const textButton = h('button', { type: 'button', class: 'btn', disabled: !reachable, onclick: () => run(() => textContact(crm, contact)) }, icon('message'), 'Text');
    let sandboxOnly = false;
    function drawSandboxHint() {
        const text = contactSandboxHint(sandboxOnly, contact.main_phone);
        sandboxHint.textContent = text || '';
        sandboxHint.hidden = !text;
        for (const button of [callButton, textButton]) {
            if (text) {
                button.setAttribute('aria-describedby', 'sandbox-hint');
            } else {
                button.removeAttribute('aria-describedby');
            }
        }
    }
    show(main, h('div', { class: 'contact-view' },
        h('a', { class: 'back', href: '/contacts' }, icon('chevron-left'), 'Contacts'),
        h('header', { class: 'profile' },
            avatar,
            info,
            h('div', { class: 'acts' },
                callButton,
                textButton,
                h('button', { type: 'button', class: 'btn', 'data-consent': true, 'aria-label': 'Record consent', onclick: openSheet },
                    icon('shield'),
                    h('span', { class: 'l-full' }, 'Record consent'),
                    h('span', { class: 'l-short' }, 'Consent')
                ),
                h('button', { type: 'button', class: 'iconbtn ctx-toggle', 'aria-controls': 'context', onclick: () => shell.toggleRail() }, icon('panel-right'))
            )
        ),
        existed ? infoNotice('Already in your contacts', 'A contact with that phone or email already existed, so it was opened instead. Its empty fields were filled in.') : null,
        problems,
        reachable ? null : h('p', { class: 'hint' }, 'Add a phone number to call or text.'),
        sandboxHint,
        tabs.list,
        tabs.panels,
        sheet.element
    ));
    shell.sync();
    shell.setContact(contact);
    // Never rejects; the page is complete without it.
    crm.sandboxOnly().then((on) => {
        if (isCurrent()) {
            sandboxOnly = on;
            drawSandboxHint();
        }
    });

    // The card loads the contact and its timeline itself, with the contacts
    // token manager. Its own Call and Text buttons fire events; they do the
    // same as the buttons above.
    card.addEventListener('dc-call', () => run(() => callContact(crm, contact)));
    card.addEventListener('dc-text', () => run(() => textContact(crm, contact)));
    card.addEventListener('dc-add-campaign', () => toast('Campaigns are read-only in this starter. Add contacts to campaigns in Drop Cowboy.'));

    // The Dock follows the contact on screen. If calling is not set up yet the
    // banner already says why, and the rest of this page works without it.
    focusContact(crm, contact).catch(() => {});

    const cleanup = () => {
        unsubscribe();
        focusContact(crm, null).catch(() => {});
    };

    try {
        const { tokenManager } = await contactWidgets(crm, ['dc-contact-card']);
        if (!isCurrent()) {
            return cleanup;
        }
        connectContactWidget(card, crm, tokenManager);
        card.contactId = contact.id;
        cardStatus.replaceWith(card);
    } catch (err) {
        cardStatus.replaceWith(errorNotice(err, crm));
    }

    return cleanup;
}
