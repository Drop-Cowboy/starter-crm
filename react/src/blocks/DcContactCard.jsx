import { useRef } from 'react';
import { useCrm } from '../crm-context.js';
import { useElementEvent } from '../hooks.js';

/**
 * <dc-contact-card>: the contact plus its activity timeline, loaded by the
 * element itself.
 *
 * React 19 passes props to a custom element as JavaScript properties when
 * the element defines them, which is why the element must be defined before
 * this renders (useContactWidgets does that). The token manager therefore
 * never becomes an HTML attribute.
 *
 * @param {{
 *   contactId: string,
 *   tokenManager: object,
 *   onCall?: (event: CustomEvent) => void,
 *   onText?: (event: CustomEvent) => void,
 *   onAddCampaign?: (event: CustomEvent) => void
 * }} props
 */
export function DcContactCard({ contactId, tokenManager, onCall, onText, onAddCampaign }) {
    const crm = useCrm();
    const ref = useRef(null);
    useElementEvent(ref, 'dc-call', onCall);
    useElementEvent(ref, 'dc-text', onText);
    useElementEvent(ref, 'dc-add-campaign', onAddCampaign);
    return (
        <dc-contact-card
            ref={ref}
            className="widget"
            apiBase={crm.widgetApiBase}
            tokenManager={tokenManager}
            contactId={contactId}
        />
    );
}
