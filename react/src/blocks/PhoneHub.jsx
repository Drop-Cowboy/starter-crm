import { useRef } from 'react';
import { startPhoneHub } from '@shared/widgets.js';
import { useElementEvent, useOpenWidget } from '../hooks.js';
import { ErrorNotice, Loading } from '../components/Notice.jsx';
import { Widget } from '../components/Page.jsx';

/**
 * <dc-phone-hub> with the phone token, the only token that can rent numbers.
 * The phone bundle signs the element in itself once startPhoneHub() runs,
 * so no token is passed as a prop here. `children` render once it is
 * signed in, which is when a <DcNumberPicker> inside them can be adopted.
 * @param {{ onAddNumber?: (event: CustomEvent) => void, children?: import('react').ReactNode }} props
 */
export function DcPhoneHub({ onAddNumber, children }) {
    const hub = useRef(null);
    const { ready, error } = useOpenWidget(hub, startPhoneHub);
    useElementEvent(hub, 'dc-number-add', onAddNumber);
    return (
        <>
            <Widget name="<dc-phone-hub>">
                {!ready && !error && <Loading label="Loading phone hub…" />}
                {error && <ErrorNotice error={error} />}
                <dc-phone-hub ref={hub} className="widget" hidden={!ready} />
            </Widget>
            {ready && children}
        </>
    );
}

/**
 * <dc-number-picker>: searches for and rents a number, asking first.
 * Render it as a child of <DcPhoneHub>, so it mounts after the phone bundle
 * is signed in; the bundle then adopts it and hands it the session.
 * @param {{ onPurchased?: (event: CustomEvent) => void }} props
 */
export function DcNumberPicker({ onPurchased }) {
    const ref = useRef(null);
    useElementEvent(ref, 'dc-number-purchased', onPurchased);
    return <dc-number-picker ref={ref} className="widget" />;
}
