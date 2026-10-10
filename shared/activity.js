// One list of "what just happened" for the activity feed, fed by two sources:
// webhooks pushed by the server (connectEvents) and events the Dock fires in
// this page (call started, message sent, ...). Both become the same shape.

const MAX_ITEMS = 50;

// Readable labels for the webhook events a contacts CRM cares about most.
// Anything else is shown by its name, so a new event type never breaks the feed.
const WEBHOOK_LABELS = {
    'contact.created': 'Contact created',
    'contact.updated': 'Contact updated',
    'contact.deleted': 'Contact deleted',
    'contact.msg.received': 'Text received',
    'contact.msg.sent': 'Text sent',
    'contact.msg.opt_out': 'Contact opted out of texts',
    'contact.sms.status': 'Text delivery update',
    'contact.call.answered': 'Call answered',
    'contact.call.missed': 'Call missed',
    'contact.call.hangup': 'Call ended',
    'contact.voicemail.received': 'Voicemail received',
    'contact.rvm.status': 'Voicemail drop update',
    'contact.consent.granted': 'Consent granted',
    'contact.consent.revoked': 'Consent revoked',
    'contact.pipeline.stage.entered': 'Pipeline stage changed',
    'campaign.started': 'Campaign started',
    'campaign.paused': 'Campaign paused',
    'campaign.completed': 'Campaign completed'
};

/**
 * @typedef {'text' | 'call' | 'voicemail' | 'consent' | 'pipeline' | 'other'} ActivityFamily
 */

/**
 * @typedef {object} ActivityItem
 * @property {string} id
 * @property {'webhook' | 'dock'} source
 * @property {string | null} event   the webhook's event type, e.g. "contact.msg.received"; null for the Dock
 * @property {ActivityFamily} family  what kind of thing happened, for its icon
 * @property {string} title
 * @property {string} detail
 * @property {string | null} contactId
 * @property {number} at   epoch ms
 * @property {boolean} replayed   history the page loaded with, not news: list it, but do not announce or count it
 */

const FAMILY_PREFIXES = [
    ['contact.msg.opt_out', 'consent'],
    ['contact.consent.', 'consent'],
    ['contact.msg.', 'text'],
    ['contact.sms.', 'text'],
    ['contact.call.', 'call'],
    ['contact.voicemail.', 'voicemail'],
    ['contact.rvm.', 'voicemail'],
    ['contact.pipeline.', 'pipeline']
];

/** @param {string | null} name @returns {ActivityFamily} */
export function webhookFamily(name) {
    const text = String(name || '');
    for (const [prefix, family] of FAMILY_PREFIXES) {
        if (text.startsWith(prefix)) {
            return family;
        }
    }
    return 'other';
}

/**
 * @param {import('./events.js').WebhookEvent} event
 * @param {{ replayed?: boolean }} [meta]   as passed by connectEvents
 * @returns {ActivityItem}
 */
export function fromWebhook(event, meta) {
    const data = event.data || {};
    const name = event.event || 'webhook';
    const detailParts = [];
    if (data.status) {
        detailParts.push(String(data.status));
    }
    if (data.from || data.to || data.number) {
        detailParts.push(String(data.from || data.to || data.number));
    }
    return {
        id: event.event_id,
        source: 'webhook',
        event: event.event || null,
        family: webhookFamily(event.event),
        title: WEBHOOK_LABELS[name] || name,
        detail: detailParts.join(' · '),
        contactId: typeof data.contact_id === 'string' ? data.contact_id : null,
        at: event.event_at || event.received_at || Date.now(),
        replayed: Boolean(meta && meta.replayed)
    };
}

const DOCK_TITLES = {
    callStarted: 'Call started',
    callEnded: 'Call ended',
    messageSent: 'Text sent from the Dock'
};

/**
 * @param {'callStarted' | 'callEnded' | 'messageSent'} kind
 * @param {{ number?: string, to?: string, contact_id?: string, disposition?: string }} detail
 * @returns {ActivityItem}
 */
export function fromDock(kind, detail) {
    const d = detail || {};
    const parts = [];
    if (d.number || d.to) {
        parts.push(String(d.number || d.to));
    }
    if (d.disposition) {
        parts.push(String(d.disposition));
    }
    return {
        id: crypto.randomUUID(),
        source: 'dock',
        event: null,
        family: kind === 'messageSent' ? 'text' : 'call',
        title: DOCK_TITLES[kind] || kind,
        detail: parts.join(' · '),
        contactId: d.contact_id || null,
        at: Date.now(),
        replayed: false
    };
}

/**
 * A tiny observable list, newest first. UI code subscribes and re-renders.
 */
export function createActivityLog() {
    let items = [];
    const listeners = new Set();

    function add(item) {
        items = [item].concat(items).slice(0, MAX_ITEMS);
        for (const listener of listeners) {
            listener(items, item);
        }
    }

    return {
        add,
        items: function () {
            return items;
        },
        /** listener(items, newestItem). Returns an unsubscribe function. */
        subscribe: function (listener) {
            listeners.add(listener);
            return function () {
                listeners.delete(listener);
            };
        }
    };
}
