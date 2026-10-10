import { getBusinessNumber } from '/shared/settings.js';
import { connectInbox, sessionWidgets } from '/shared/widgets.js';
import { h, show } from '../dom.js';
import { errorNotice, loading } from '../notice.js';
import { page, widgetFrame } from '../page.js';

/** The shared inbox: every text conversation the team has through this app. */
export async function renderInbox(main, { crm, isCurrent }) {
    const missingNumber = h('div');
    const problems = h('div');
    const status = loading('Loading inbox…');
    show(main, page('Inbox', null,
        missingNumber,
        problems,
        widgetFrame('dc-shared-inbox', { grow: true }, status)
    ));

    let tokenManager;
    try {
        ({ tokenManager } = await sessionWidgets(crm, ['dc-shared-inbox']));
    } catch (err) {
        status.replaceWith(errorNotice(err, crm));
        return undefined;
    }
    if (!isCurrent()) {
        return undefined;
    }

    const inbox = document.createElement('dc-shared-inbox');
    inbox.className = 'widget';
    connectInbox(inbox, crm, tokenManager);
    // A refused reply (consent, opt-out, funds) arrives as dc-error with a code.
    inbox.addEventListener('dc-error', (event) => show(problems, errorNotice(event.detail, crm)));
    inbox.addEventListener('dc-select-conversation', () => problems.replaceChildren());
    // Asked for only once the inbox can load: without a carrier a business
    // number would not help.
    if (!getBusinessNumber()) {
        show(missingNumber, errorNotice({ code: 'business_number_missing' }, crm));
    }
    status.replaceWith(inbox);
    return undefined;
}
