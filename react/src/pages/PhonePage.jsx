import { useRef } from 'react';
import { DcNumberPicker, DcPhoneHub } from '../blocks/PhoneHub.jsx';
import { InfoNotice } from '../components/Notice.jsx';
import { Page, WidgetTag } from '../components/Page.jsx';
import { useToast } from '../components/Toasts.jsx';
import { useCrm } from '../crm-context.js';
import { usePageTitle } from '../hooks.js';

/**
 * Phone numbers and routing. This is the only page with the phone token,
 * because it can rent numbers, which costs money. Renting asks first.
 */
export function PhonePage() {
    usePageTitle('Phone');
    const crm = useCrm();
    const toast = useToast();
    const pickerSection = useRef(null);

    function purchased(event) {
        const number = event.detail && event.detail.number;
        toast('Number added: ' + ((number && (number.display || number.number)) || 'new number'));
    }

    return (
        <Page title="Phone" hint="Your numbers and where calls to them go. Getting a number charges your account, so you are asked to confirm first.">
            {crm.tokens.supports('phone')
                ? (
                    <div className="pgrid">
                        <DcPhoneHub onAddNumber={() => pickerSection.current && pickerSection.current.focus()}>
                            <section className="wa" ref={pickerSection} tabIndex={-1} aria-labelledby="get-number-title">
                                <WidgetTag name="<dc-number-picker>" />
                                <h2 id="get-number-title">Get a number</h2>
                                <DcNumberPicker onPurchased={purchased} />
                            </section>
                        </DcPhoneHub>
                    </div>
                )
                : (
                    <InfoNotice title="Phone is not available in this mode">
                        mcp-session mode only has the session token. Run the starter in server or login mode to manage numbers.
                    </InfoNotice>
                )}
        </Page>
    );
}
