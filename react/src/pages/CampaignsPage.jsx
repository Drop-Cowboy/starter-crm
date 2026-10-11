import { CampaignHub } from '../blocks/CampaignHub.jsx';
import { InfoNotice } from '../components/Notice.jsx';
import { Page, Widget } from '../components/Page.jsx';
import { useCrm } from '../crm-context.js';
import { usePageTitle } from '../hooks.js';

/**
 * Read-only campaign results, with a campaigns-only token. That token
 * cannot start, pause or create campaigns, so this page does not offer to.
 */
export function CampaignsPage() {
    usePageTitle('Campaigns');
    const crm = useCrm();
    return (
        <Page title="Campaigns" hint="A read-only view of your campaigns and their results. Start, pause and create campaigns in Drop Cowboy.">
            {crm.tokens.supports('campaigns')
                ? <Widget name="Campaign hub"><CampaignHub /></Widget>
                : (
                    <InfoNotice title="Campaigns are not available in this mode">
                        mcp-session mode only has the session token. Run the starter in server or login mode to see campaigns.
                    </InfoNotice>
                )}
        </Page>
    );
}
