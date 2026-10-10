import { Link } from 'react-router';
import { formatTime } from '@shared/format.js';
import { useAppPath } from '../layout-context.js';
import { Icon } from './Icon.jsx';

// The chip color and icon for each kind of event.
const FAMILIES = {
    text: { chip: 'ic-sms', icon: 'message' },
    call: { chip: 'ic-call', icon: 'phone' },
    voicemail: { chip: 'ic-vm', icon: 'voicemail' },
    consent: { chip: 'ic-ok', icon: 'shield' },
    pipeline: { chip: 'ic-pipe', icon: 'kanban' },
    other: { chip: 'ic-ct', icon: 'activity' }
};

function ActivityItem({ item }) {
    const appPath = useAppPath();
    const family = FAMILIES[item.family] ? item.family : 'other';
    return (
        <li>
            <span className={'tldot ' + FAMILIES[family].chip} data-family={family} aria-hidden="true">
                <Icon name={FAMILIES[family].icon} />
            </span>
            <div>
                <div className="ft">
                    {item.contactId
                        ? <Link to={appPath('/contacts/' + encodeURIComponent(item.contactId))}>{item.title}</Link>
                        : <strong>{item.title}</strong>}
                    {item.detail && <span className="fd"> · {item.detail}</span>}
                </div>
                {item.event && <div className="fe"><span className="mono">{item.event}</span></div>}
                <div className="fw">{(item.source === 'webhook' ? 'Webhook · ' : 'Dock · ') + formatTime(item.at)}</div>
            </div>
        </li>
    );
}

/**
 * Activity items as a feed: a colored chip per kind of event, the event
 * type for webhooks, and a link to the contact when there is one.
 * @param {{ items: object[], id?: string, label: string, hidden?: boolean }} props
 */
export function ActivityList({ items, id, label, hidden }) {
    return (
        <ol className="feed" id={id} aria-label={label} hidden={hidden}>
            {items.map((item) => <ActivityItem item={item} key={item.id} />)}
        </ol>
    );
}
