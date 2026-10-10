import { openCampaignHub } from '/shared/widgets.js';
import { h, show } from '../dom.js';
import { errorNotice, infoNotice, loading } from '../notice.js';
import { page, widgetFrame } from '../page.js';

/**
 * Read-only campaign results, with a campaigns-only token. That token
 * cannot start, pause or create campaigns, so this page does not offer to.
 */
export async function renderCampaigns(main, { crm, isCurrent }) {
    const hint = 'A read-only view of your campaigns and their results. Start, pause and create campaigns in Drop Cowboy.';
    if (!crm.tokens.supports('campaigns')) {
        show(main, page('Campaigns', hint, infoNotice('Campaigns are not available in this mode',
            'mcp-session mode only has the session token. Run the starter in server or login mode to see campaigns.')));
        return undefined;
    }

    const container = h('div', { class: 'widget' });
    const status = loading('Loading campaigns…');
    show(main, page('Campaigns', hint, widgetFrame('Campaign hub', {}, status, container)));

    let close;
    try {
        close = await openCampaignHub(crm, container);
    } catch (err) {
        show(container, errorNotice(err, crm));
        return undefined;
    } finally {
        status.remove();
    }
    if (!isCurrent()) {
        close();
        return undefined;
    }
    return close;
}
