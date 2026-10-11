import { useRef } from 'react';
import { openCampaignHub } from '@shared/widgets.js';
import { useOpenWidget } from '../hooks.js';
import { ErrorNotice, Loading } from '../components/Notice.jsx';

/**
 * The campaign hub, opened by the campaigns bundle into a container div with
 * its own campaigns-only token. React owns the div; the bundle owns what is
 * inside it, so React never renders children into it.
 */
export function CampaignHub() {
    const container = useRef(null);
    const { ready, error } = useOpenWidget(container, openCampaignHub);
    return (
        <>
            {!ready && !error && <Loading label="Loading campaigns…" />}
            {error && <ErrorNotice error={error} />}
            <div className="widget" ref={container} />
        </>
    );
}
