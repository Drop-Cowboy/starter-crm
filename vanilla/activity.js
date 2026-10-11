import { connectEvents } from '/shared/events.js';
import { fromWebhook } from '/shared/activity.js';
import { formatTime } from '/shared/format.js';
import { h, icon, show } from './dom.js';

const STATUS_TEXT = {
    connecting: 'Connecting to live events…',
    open: 'Live: webhooks appear here as Drop Cowboy sends them.',
    reconnecting: 'Live events disconnected. Reconnecting…'
};

const CONNECTION_TEXT = {
    connecting: 'Connecting…',
    open: 'Live events connected',
    reconnecting: 'Reconnecting…'
};

// The colored chip and icon for each kind of event.
const FAMILY_LOOK = {
    text: { className: 'ic-sms', icon: 'message' },
    call: { className: 'ic-call', icon: 'phone' },
    voicemail: { className: 'ic-vm', icon: 'voicemail' },
    consent: { className: 'ic-ok', icon: 'shield' },
    pipeline: { className: 'ic-pipe', icon: 'kanban' },
    other: { className: 'ic-ct', icon: 'activity' }
};

const TOAST_MS = 5000;

/** Shows a short message in the polite live region, then removes it. */
export function toast(text) {
    const box = document.getElementById('toasts');
    const item = h('div', { class: 'toast' }, text);
    box.appendChild(item);
    setTimeout(() => item.remove(), TOAST_MS);
}

/**
 * One activity entry, for the context region and a contact's Activity tab.
 * The title links to the contact when the event names one.
 */
export function activityItem(item) {
    const family = FAMILY_LOOK[item.family] ? item.family : 'other';
    const look = FAMILY_LOOK[family];
    const title = item.contactId
        ? h('a', { href: '/contacts/' + encodeURIComponent(item.contactId) }, item.title)
        : h('strong', null, item.title);
    return h('li', null,
        h('span', { class: 'tldot ' + look.className, 'data-family': family, 'aria-hidden': 'true' }, icon(look.icon)),
        h('div', null,
            h('div', { class: 'ft' }, title, item.detail ? h('span', { class: 'fd' }, ' · ' + item.detail) : null),
            item.event ? h('div', { class: 'fe' }, h('span', { class: 'mono' }, item.event)) : null,
            h('div', { class: 'fw' }, (item.source === 'webhook' ? 'Webhook · ' : 'Dock · ') + formatTime(item.at))
        )
    );
}

/**
 * Wires the Activity list in the context region: live webhooks from the
 * server plus Dock events. `onItem` runs for each new entry, but not for the
 * history the server replays when the page loads.
 * @param {object} crm
 * @param {{ onItem: () => void }} options
 */
export function startActivityFeed(crm, options) {
    const list = document.getElementById('activity-list');
    const empty = document.getElementById('activity-empty');
    const status = document.getElementById('activity-status');
    const pulse = document.querySelector('#context .pulse');
    const connection = document.getElementById('activity-connection');

    crm.activity.subscribe((items, newest) => {
        show(list, items.map(activityItem));
        empty.hidden = items.length > 0;
        if (!newest.replayed) {
            toast(newest.title + (newest.detail ? ': ' + newest.detail : ''));
            options.onItem();
        }
    });

    return connectEvents({
        onEvent: (event, meta) => crm.activity.add(fromWebhook(event, meta)),
        onStatus: (state) => {
            status.textContent = STATUS_TEXT[state];
            connection.textContent = CONNECTION_TEXT[state];
            pulse.setAttribute('data-status', state);
        }
    });
}
