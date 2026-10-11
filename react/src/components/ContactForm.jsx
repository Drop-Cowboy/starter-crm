import { useId, useState } from 'react';
import { FIELD_INPUTS } from '@shared/contacts-api.js';
import { ErrorNotice } from './Notice.jsx';

/**
 * A labelled form for the standard contact fields. Errors from onSubmit are
 * explained inside the form, next to what the user was doing.
 * @param {{
 *   values?: Record<string, string>,
 *   submitLabel: string,
 *   onSubmit: (values: Record<string, string>) => Promise<void>
 * }} props
 */
export function ContactForm({ values, submitLabel, onSubmit }) {
    const id = useId();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    async function handleSubmit(event) {
        event.preventDefault();
        setSaving(true);
        setError(null);
        try {
            await onSubmit(Object.fromEntries(new FormData(event.currentTarget)));
        } catch (err) {
            setError(err);
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="card" noValidate onSubmit={handleSubmit}>
            <div>{error && <ErrorNotice error={error} />}</div>
            <div className="form-grid">
                {FIELD_INPUTS.map((field) => (
                    <div className="field" key={field.name}>
                        <label htmlFor={id + field.name}>{field.label}</label>
                        <input
                            id={id + field.name}
                            name={field.name}
                            type={field.type}
                            autoComplete={field.autocomplete}
                            defaultValue={(values && values[field.name]) || ''}
                        />
                    </div>
                ))}
            </div>
            <div className="actions">
                <button type="submit" className="btn primary" disabled={saving}>{submitLabel}</button>
                <p className="hint" role="status">{saving ? 'Saving…' : ''}</p>
            </div>
        </form>
    );
}
