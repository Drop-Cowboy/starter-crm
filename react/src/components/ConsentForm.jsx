import { useId, useState } from 'react';
import { CONSENT_METHOD_LABELS, CONSENT_METHODS } from '@shared/contacts-api.js';
import { useCrm } from '../crm-context.js';
import { ErrorNotice } from './Notice.jsx';

/**
 * Records consent a contact gave you outside Drop Cowboy, so calls and texts
 * to them pass the consent check. Errors are explained inside the form.
 * @param {{
 *   contact: { id: string, main_phone: string },
 *   labelledBy: string,
 *   onCancel: () => void,
 *   onRecorded: () => void
 * }} props
 */
export function ConsentForm({ contact, labelledBy, onCancel, onRecorded }) {
    const crm = useCrm();
    const id = useId();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    async function handleSubmit(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setSaving(true);
        setError(null);
        try {
            await crm.contacts.recordConsent(contact.id, {
                phone_number: contact.main_phone,
                channels: data.getAll('channels'),
                consent_method: data.get('consent_method'),
                consent_text: data.get('consent_text')
            });
            form.reset();
            onRecorded();
        } catch (err) {
            setError(err);
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="sheet-b" aria-labelledby={labelledBy} noValidate onSubmit={handleSubmit}>
            <p className="note">Only record consent the contact actually gave you. Opt-outs, STOP replies and Do Not Call still block.</p>
            <div>{error && <ErrorNotice error={error} />}</div>
            <fieldset>
                <legend>They agreed to</legend>
                <label><input type="checkbox" name="channels" value="sms" /> Texts</label>
                <label><input type="checkbox" name="channels" value="calls" /> Calls</label>
            </fieldset>
            <div className="field">
                <label htmlFor={id + 'method'}>How they agreed</label>
                <select id={id + 'method'} name="consent_method">
                    {CONSENT_METHODS.map((m) => <option key={m} value={m}>{CONSENT_METHOD_LABELS[m]}</option>)}
                </select>
            </div>
            <div className="field">
                <label htmlFor={id + 'text'}>What they agreed to</label>
                <textarea
                    id={id + 'text'}
                    name="consent_text"
                    rows={3}
                    placeholder="The exact wording, for example: I agree to receive texts from Example Co. Reply STOP to opt out."
                />
            </div>
            <div className="actions">
                <button type="submit" className="btn primary" disabled={saving}>Record consent</button>
                <button type="button" className="btn sec" onClick={onCancel}>Cancel</button>
                <p className="hint" role="status">{saving ? 'Recording…' : ''}</p>
            </div>
        </form>
    );
}
