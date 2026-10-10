import { startPhoneHub } from '/shared/widgets.js';
import { toast } from '../activity.js';
import { h, show } from '../dom.js';
import { errorNotice, infoNotice, loading } from '../notice.js';
import { page, widgetFrame } from '../page.js';

/**
 * Phone numbers and routing. This is the only page with the phone token,
 * because it can rent numbers, which costs money. Renting asks first.
 */
export async function renderPhone(main, { crm, isCurrent }) {
    const hint = 'Your numbers and where calls to them go. Getting a number charges your account, so you are asked to confirm first.';
    if (!crm.tokens.supports('phone')) {
        show(main, page('Phone', hint, infoNotice('Phone is not available in this mode',
            'mcp-session mode only has the session token. Run the starter in server or login mode to manage numbers.')));
        return undefined;
    }

    const status = loading('Loading phone hub…');
    const hub = document.createElement('dc-phone-hub');
    hub.className = 'widget';
    const grid = h('div', { class: 'pgrid' }, widgetFrame('dc-phone-hub', {}, status));
    show(main, page('Phone', hint, grid));

    let close;
    try {
        close = await startPhoneHub(crm, hub);
    } catch (err) {
        status.replaceWith(errorNotice(err, crm));
        return undefined;
    }
    if (!isCurrent()) {
        close();
        return undefined;
    }
    status.replaceWith(hub);

    // Added after init, so the phone bundle hands it the session itself.
    const picker = document.createElement('dc-number-picker');
    picker.className = 'widget';
    const pickerSection = widgetFrame('dc-number-picker', {
        tag: 'section',
        attrs: { tabindex: '-1', 'aria-labelledby': 'get-number-title' }
    }, h('h2', { id: 'get-number-title' }, 'Get a number'), picker);
    grid.appendChild(pickerSection);

    hub.addEventListener('dc-number-add', () => pickerSection.focus());
    picker.addEventListener('dc-number-purchased', (event) => {
        const number = event.detail && event.detail.number;
        toast('Number added: ' + ((number && (number.display || number.number)) || 'new number'));
    });

    return close;
}
