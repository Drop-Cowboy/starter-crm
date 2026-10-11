// Small display and input helpers. No dependencies, no DOM.

/** "Dana Reyes", else the email, else the phone, else "Unnamed contact". */
export function contactName(contact) {
    if (!contact) {
        return '';
    }
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
    return name || contact.email || formatPhone(contact.main_phone) || 'Unnamed contact';
}

/** "DR" for Dana Reyes, the first letter otherwise, for an avatar. */
export function contactInitials(contact) {
    const first = String((contact && contact.first_name) || '').trim();
    const last = String((contact && contact.last_name) || '').trim();
    if (first || last) {
        return ((first[0] || '') + (last[0] || '')).toUpperCase();
    }
    const name = contactName(contact).replace(/[^\p{L}\p{N}]/gu, '');
    return (name[0] || '?').toUpperCase();
}

export function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/**
 * A US/Canada number typed any common way, as E.164 ("+13125550142").
 * Numbers that already start with + are kept if they have 8 to 15 digits.
 * Returns '' when the text is not a phone number.
 */
export function toE164(value) {
    const text = String(value || '').trim();
    if (!text || /[a-z@]/i.test(text)) {
        return '';
    }
    const digits = text.replace(/\D/g, '');
    if (text.startsWith('+')) {
        return digits.length >= 8 && digits.length <= 15 ? '+' + digits : '';
    }
    if (digits.length === 10) {
        return '+1' + digits;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
        return '+' + digits;
    }
    return '';
}

/** "+13125550142" as "(312) 555-0142". Other numbers are returned as given. */
export function formatPhone(value) {
    const text = String(value || '');
    const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(text);
    return match ? '(' + match[1] + ') ' + match[2] + '-' + match[3] : text;
}

export function formatDate(epochMs) {
    if (!epochMs) {
        return '';
    }
    return new Date(epochMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Oct 9", for list rows. */
export function formatShortDate(epochMs) {
    if (!epochMs) {
        return '';
    }
    return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTime(epochMs) {
    return new Date(epochMs || Date.now()).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
