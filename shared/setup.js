// The setup checklist: what a Drop Cowboy account needs before the CRM's
// calling, texting and contact widgets work, and how to fix each gap.
//
// In server and login modes the server can ask Drop Cowboy
// (GET /api/dropcowboy/readiness), so each item gets a live done/not-done.
// In mcp-session mode there is no readiness route; the page shows the same
// steps as the setup guide your AI agent follows (get_builder_setup_guide
// with goal "crm"), with nothing checked.

const DASHBOARD = 'https://www.dropcowboy.com/app/#';

/**
 * @typedef {object} SetupItem
 * @property {string} id       Also the page anchor, e.g. /setup#connect_byoc.
 * @property {string} title
 * @property {string} help     What it is and how to fix it.
 * @property {boolean | null} done  null when it cannot be checked from here.
 * @property {boolean} optional
 * @property {{ href: string, label: string } | null} link
 */

/**
 * @typedef {object} Readiness  The fields GET /api/dropcowboy/readiness returns.
 * @property {boolean} embed_ready
 * @property {string[]} next_actions
 * @property {boolean} building_blocks_enabled
 * @property {{ connected: boolean, providers: { provider: string }[] }} byoc
 * @property {{ available: number, funds_ok: boolean }} funds
 * @property {{ count: number }} numbers
 * @property {boolean} embed_resolve_contact_consent
 */

/**
 * @param {Readiness | null} readiness  null when it cannot be read in this mode.
 * @param {{ siteId: string | null, businessNumber: string }} local
 * @returns {SetupItem[]}
 */
export function setupChecklist(readiness, local) {
    const r = readiness;
    const known = !!r;
    return [
        {
            id: 'enable_building_blocks',
            title: 'Turn on Building Blocks',
            help: 'Building Blocks is a team setting. Turning it on moves the team off the shared retail number pool, '
                + 'so retail numbers are released. An admin turns it on in the dashboard.',
            done: known ? r.building_blocks_enabled === true : null,
            optional: false,
            link: { href: DASHBOARD + '/building-blocks', label: 'Building Blocks settings' }
        },
        {
            id: 'connect_byoc',
            title: 'Connect your carrier (BYOC)',
            help: 'Calls and texts run on your own carrier account, such as Twilio or Telnyx. '
                + 'Until one is connected the session token for calling and texting cannot be minted (byoc_required). '
                + 'The contacts pages use their own contacts token and work without one.',
            done: known ? !!(r.byoc && r.byoc.connected) : null,
            optional: false,
            link: { href: DASHBOARD + '/building-blocks', label: 'Connect a carrier' }
        },
        {
            id: 'funds',
            title: 'Allotment or funds',
            help: 'Usage draws from your plan allotment first, then your prepaid balance. '
                + 'When both are empty, calls return 402 payment_required.',
            done: known ? !!(r.funds && r.funds.funds_ok) : null,
            optional: false,
            link: { href: DASHBOARD + '/settings', label: 'Billing in the dashboard' }
        },
        {
            id: 'phone_number',
            title: 'A phone number',
            help: 'Calls and texts go out from a number on your account. The Phone page can get one.',
            done: known ? !!(r.numbers && r.numbers.count > 0) : null,
            optional: false,
            link: null
        },
        {
            id: 'texting_line',
            title: 'Texting registration (10DLC)',
            help: 'Texting in the US needs the number on an approved texting (10DLC) campaign with the carrier. '
                + 'Without one, US texts are rejected. Registration happens in the Trust Center; this page cannot check it.',
            done: null,
            optional: false,
            link: { href: DASHBOARD + '/trust-center', label: 'Trust Center' }
        },
        {
            id: 'e911_location',
            title: 'E911 location for calling',
            help: 'Dialing needs a team emergency (E911) address. Set it in Phone Hub in the dashboard; '
                + 'it cannot be set from an embedded page.',
            done: null,
            optional: false,
            link: { href: DASHBOARD + '/phone-hub', label: 'Phone Hub' }
        },
        {
            id: 'site_id',
            title: 'A site id for this app',
            help: 'One UUID per deployed app, in DROPCOWBOY_SITE_ID. It keeps this app\'s inbox threads separate, '
                + 'so changing it later hides earlier threads.',
            done: local.siteId ? true : (known ? false : null),
            optional: false,
            link: null
        },
        {
            id: 'business_number',
            title: 'Your business number',
            help: 'The number this CRM texts from. Save it below; it is kept in this browser only.',
            done: !!local.businessNumber,
            optional: false,
            link: null
        },
        {
            id: 'contact_consent',
            title: 'Use existing contact consent (optional)',
            help: 'Off by default. When on, a text or call that names a contact uses the consent already recorded on that contact. '
                + 'A contact without granted consent is still refused with consent_required; nothing is bypassed.',
            done: known ? r.embed_resolve_contact_consent === true : null,
            optional: true,
            link: { href: DASHBOARD + '/building-blocks', label: 'Building Blocks settings' }
        }
    ];
}

/**
 * The badge for one item. An optional setting that is off is not a to-do.
 * @param {SetupItem} item
 * @returns {{ label: string, className: string }}
 */
export function itemStatus(item) {
    if (item.done === null) {
        return { label: 'Check', className: 'unknown' };
    }
    if (item.optional) {
        return item.done ? { label: 'On', className: 'done' } : { label: 'Optional', className: 'unknown' };
    }
    return item.done ? { label: 'Done', className: 'done' } : { label: 'To do', className: 'todo' };
}

/** True when nothing required is known to be missing. */
export function isReady(items) {
    for (let i = 0; i < items.length; i++) {
        if (!items[i].optional && items[i].done === false) {
            return false;
        }
    }
    return true;
}
