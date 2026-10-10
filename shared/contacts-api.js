import { WIDGET_API_BASE } from './config.js';
import { AppError, errorFromResponse, networkError } from './errors.js';
import { isEmail, toE164 } from './format.js';

// The headless Contacts API, called straight from the browser with the
// contacts site token (Authorization: Bearer). The site token is short-lived
// and scoped to this team's contacts, which is why it may sit in page memory
// while an API key may not. It cannot call, so it mints even for a team with
// no connected carrier and no balance.
//
// Every call reads a token from the shared token store. If the API answers
// 401 (the token expired between reading and sending), it asks the store for
// a new one and tries exactly once more.

export const STANDARD_FIELDS = ['first_name', 'last_name', 'email', 'main_phone', 'company'];

/** What a contact form shows for each standard field. */
export const FIELD_INPUTS = [
    { name: 'first_name', label: 'First name', type: 'text', autocomplete: 'given-name' },
    { name: 'last_name', label: 'Last name', type: 'text', autocomplete: 'family-name' },
    { name: 'main_phone', label: 'Phone', type: 'tel', autocomplete: 'tel' },
    { name: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
    { name: 'company', label: 'Company', type: 'text', autocomplete: 'organization' }
];

const PAGE_SIZE = 25;

/**
 * @typedef {object} Contact
 * @property {string} id
 * @property {string} first_name
 * @property {string} last_name
 * @property {string} email
 * @property {string} main_phone
 * @property {string} company
 * @property {boolean} dnc
 * @property {number | null} created_at
 */

/**
 * @param {{
 *   tokens: { get(purpose: string): Promise<{ token: string }>, refresh(purpose: string): Promise<{ token: string }> },
 *   apiBase?: string,
 *   fetch?: typeof fetch
 * }} options
 */
export function createContactsApi(options) {
    const tokens = options.tokens;
    const base = (options.apiBase || WIDGET_API_BASE) + '/contact/public/contacts';
    const fetchImpl = options.fetch || globalThis.fetch;

    async function send(path, init, token) {
        const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
        if (init.body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        try {
            return await fetchImpl(base + path, {
                method: init.method || 'GET',
                headers,
                body: init.body === undefined ? undefined : JSON.stringify(init.body)
            });
        } catch {
            throw networkError();
        }
    }

    async function request(path, init) {
        let response = await send(path, init || {}, (await tokens.get('contacts')).token);
        if (response.status === 401) {
            response = await send(path, init || {}, (await tokens.refresh('contacts')).token);
        }
        if (!response.ok) {
            throw await errorFromResponse(response);
        }
        const json = await response.json();
        return json && json.data !== undefined ? json.data : json;
    }

    /**
     * A page of contacts, newest first. `search` is free text (name, phone or email).
     * @returns {Promise<{ contacts: Contact[], total: number }>}
     */
    async function list(query) {
        const q = query || {};
        const params = new URLSearchParams({
            sort_by: 'created_at',
            sort_order: 'desc',
            offset: String(q.offset || 0),
            limit: String(q.limit || PAGE_SIZE)
        });
        if (q.search) {
            params.set('search_term', q.search);
        }
        return toPage(await request('?' + params.toString()));
    }

    /**
     * Exact lookup by phone (E.164) or email.
     * @param {{ phone?: string, email?: string }} query
     */
    async function search(query) {
        const params = new URLSearchParams();
        if (query.email) {
            params.set('email', query.email);
        } else if (query.phone) {
            params.set('phone', query.phone);
        } else {
            throw new AppError('invalid_request', 'Search needs a phone number or an email.');
        }
        return toPage(await request('/search?' + params.toString()));
    }

    /**
     * What the search box does: an email or a phone number gets an exact
     * match, anything else is free-text search.
     */
    function find(text, page) {
        const value = String(text || '').trim();
        if (isEmail(value)) {
            return search({ email: value });
        }
        const phone = toE164(value);
        if (phone) {
            return search({ phone });
        }
        return list({ search: value, offset: page && page.offset, limit: page && page.limit });
    }

    /** @returns {Promise<Contact | null>} null when no contact has that id. */
    async function get(contactId) {
        const data = await request('/' + encodeURIComponent(contactId));
        return data && data.contact ? normalizeContact(data.contact) : null;
    }

    /**
     * Creates one contact. A contact with the same phone or email already
     * existing is not an error: its empty fields are filled in and its id
     * comes back with created: false.
     * @param {Partial<Contact>} input
     * @returns {Promise<{ contact_id: string, created: boolean }>}
     */
    async function create(input) {
        const fields = [];
        const row = [];
        for (let i = 0; i < STANDARD_FIELDS.length; i++) {
            const name = STANDARD_FIELDS[i];
            const value = prepare(name, input[name]);
            if (value) {
                fields.push({ type: name });
                row.push(value);
            }
        }
        const data = await request('', {
            method: 'POST',
            body: { fields, values: [row], conflict_mode: 'append', fire_webhook_events: true }
        });
        if (data.inserted && data.inserted.length) {
            return { contact_id: data.inserted[0].contact_id, created: true };
        }
        if (data.updated && data.updated.length) {
            return { contact_id: data.updated[0].contact_id, created: false };
        }
        const rejected = data.rejected && data.rejected[0];
        throw new AppError('contact_rejected', rejected && rejected.reasons ? rejected.reasons.join(', ') : '');
    }

    /**
     * Saves the standard fields that changed, then reads the contact back to
     * confirm they stuck. A save that reports success but changed nothing is
     * the worst kind of bug in a CRM, so it is checked rather than trusted.
     * @param {string} contactId
     * @param {Partial<Contact>} changes
     */
    async function update(contactId, changes) {
        const body = {};
        for (let i = 0; i < STANDARD_FIELDS.length; i++) {
            const name = STANDARD_FIELDS[i];
            if (changes[name] !== undefined) {
                body[name] = prepare(name, changes[name]);
            }
        }
        if (!Object.keys(body).length) {
            throw new AppError('no_updatable_fields', 'Nothing changed.');
        }
        await request('/' + encodeURIComponent(contactId), { method: 'PUT', body });
        const saved = await get(contactId);
        const notSaved = [];
        const names = Object.keys(body);
        for (let i = 0; i < names.length; i++) {
            if (!saved || !sameValue(names[i], saved[names[i]], body[names[i]])) {
                notSaved.push(names[i]);
            }
        }
        if (notSaved.length) {
            throw new AppError('update_not_saved', 'Not saved: ' + notSaved.join(', ') + '.');
        }
        return saved;
    }

    async function remove(contactId) {
        await request('/' + encodeURIComponent(contactId), { method: 'DELETE' });
    }

    /**
     * Records consent the contact gave you, one record per channel. Drop
     * Cowboy stores the wording with a hash, so send what the contact
     * actually agreed to, not a summary.
     * @param {string} contactId
     * @param {{ phone_number: string, channels: string[], consent_text: string, consent_method: string }} input
     * @returns {Promise<string[]>} the consent ids, in channel order
     */
    async function recordConsent(contactId, input) {
        const phone = toE164(clean(input.phone_number));
        const text = clean(input.consent_text);
        const channels = (input.channels || []).filter((c) => CONSENT_TYPES[c]);
        if (!phone) {
            throw new AppError('invalid_request', 'The contact needs a phone number before you can record consent for it.');
        }
        if (!channels.length) {
            throw new AppError('invalid_request', 'Choose texts, calls, or both.');
        }
        if (!text) {
            throw new AppError('invalid_request', 'Enter the wording the contact agreed to.');
        }
        const ids = [];
        for (let i = 0; i < channels.length; i++) {
            const data = await request('/' + encodeURIComponent(contactId) + '/consent', {
                method: 'POST',
                body: {
                    consent_type: CONSENT_TYPES[channels[i]],
                    phone_number: phone,
                    consent_text: text,
                    consent_method: CONSENT_METHODS.includes(input.consent_method) ? input.consent_method : 'phone'
                }
            });
            ids.push((data && data.consent_id) || '');
        }
        return ids;
    }

    return { list, search, find, get, create, update, remove, recordConsent };
}

/** The channels a contact can agree to, and the consent type each records. */
const CONSENT_TYPES = { sms: 'sms_optin', calls: 'tcpa_optin' };

/** How the contact gave consent, as the consent API names it. */
export const CONSENT_METHODS = ['phone', 'in_person', 'web_form', 'paper'];

export const CONSENT_METHOD_LABELS = {
    phone: 'On a phone call',
    in_person: 'In person',
    web_form: 'On a web form',
    paper: 'On a signed form'
};

function clean(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

// Phone numbers are stored in E.164, so "(312) 555-0142" is sent as
// "+13125550142". Anything that is not recognizably a number goes as typed
// and the API answers invalid_phone.
function prepare(name, value) {
    const text = clean(value);
    if (name === 'main_phone' && text) {
        return toE164(text) || text;
    }
    return text;
}

/**
 * Only the fields the user actually changed, so a save never overwrites a
 * value someone else changed meanwhile in a field this user did not touch.
 */
export function changedFields(original, values) {
    const changes = {};
    for (let i = 0; i < STANDARD_FIELDS.length; i++) {
        const name = STANDARD_FIELDS[i];
        if (values[name] !== undefined && !sameValue(name, original[name], prepare(name, values[name]))) {
            changes[name] = values[name];
        }
    }
    return changes;
}

function sameValue(name, stored, sent) {
    const a = clean(stored);
    const b = clean(sent);
    if (name === 'main_phone') {
        return a.replace(/\D/g, '').slice(-10) === b.replace(/\D/g, '').slice(-10);
    }
    if (name === 'email') {
        return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
}

function toPage(data) {
    const rows = (data && data.contacts) || [];
    const contacts = [];
    for (let i = 0; i < rows.length; i++) {
        contacts.push(normalizeContact(rows[i]));
    }
    const total = data && typeof data.total_contacts === 'number' ? data.total_contacts : contacts.length;
    return { contacts, total };
}

/**
 * The API puts standard fields at the top level of a contact, and every
 * field (standard or custom) in field_data. Read the top level first.
 * @returns {Contact}
 */
export function normalizeContact(raw) {
    const fieldData = Array.isArray(raw.field_data) ? raw.field_data : [];
    function field(type) {
        if (raw[type]) {
            return String(raw[type]);
        }
        for (let i = 0; i < fieldData.length; i++) {
            if (fieldData[i].type === type && fieldData[i].value) {
                return String(fieldData[i].value);
            }
        }
        return '';
    }
    const phones = Array.isArray(raw.phone_numbers) ? raw.phone_numbers : [];
    return {
        id: raw.contact_id || raw.id || '',
        first_name: field('first_name'),
        last_name: field('last_name'),
        email: field('email'),
        main_phone: field('main_phone') || phones[0] || '',
        company: field('company'),
        dnc: raw.dnc === true,
        created_at: typeof raw.created_at === 'number' ? raw.created_at : null
    };
}
