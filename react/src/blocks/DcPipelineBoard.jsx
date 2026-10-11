import { useRef } from 'react';
import { useCrm } from '../crm-context.js';
import { useElementEvent } from '../hooks.js';

/**
 * <dc-pipeline-board>: loads the team's first board by itself.
 * @param {{ tokenManager: object, onOpenContact?: (contactId: string) => void }} props
 */
export function DcPipelineBoard({ tokenManager, onOpenContact }) {
    const crm = useCrm();
    const ref = useRef(null);
    useElementEvent(ref, 'dc-open-contact', (event) => {
        const detail = event.detail || {};
        // This event names the id contactId; most others say contact_id.
        const id = detail.contact_id || detail.contactId;
        if (id && onOpenContact) {
            onOpenContact(id);
        }
    });
    return <dc-pipeline-board ref={ref} className="widget" apiBase={crm.widgetApiBase} tokenManager={tokenManager} />;
}
