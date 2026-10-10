import { useRef } from 'react';
import { useCrm } from '../crm-context.js';
import { useElementEvent } from '../hooks.js';

/**
 * <dc-shared-inbox>: every text conversation the team has through this app.
 * `from` is the business number replies are sent from.
 * @param {{
 *   tokenManager: object,
 *   from: string,
 *   onError?: (event: CustomEvent) => void,
 *   onSelectConversation?: (event: CustomEvent) => void
 * }} props
 */
export function DcSharedInbox({ tokenManager, from, onError, onSelectConversation }) {
    const crm = useCrm();
    const ref = useRef(null);
    // A refused reply (consent, opt-out, funds) arrives as dc-error with a code.
    useElementEvent(ref, 'dc-error', onError);
    useElementEvent(ref, 'dc-select-conversation', onSelectConversation);
    return (
        <dc-shared-inbox
            ref={ref}
            className="widget"
            phoneApiBase={crm.widgetApiBase}
            from={from || undefined}
            tokenManager={tokenManager}
        />
    );
}
