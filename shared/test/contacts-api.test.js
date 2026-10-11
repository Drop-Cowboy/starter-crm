import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { changedFields, createContactsApi, normalizeContact } from '../contacts-api.js';
import { createTokenProvider, createTokenStore } from '../token-provider.js';
import { header, jsonResponse, scriptedFetch } from './helpers.js';

const BASE = 'https://app-api-v2.dropcowboy.com/contact/public/contacts';
const DANA = {
    contact_id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
    first_name: 'Dana',
    last_name: 'Reyes',
    email: 'dana@example.com',
    main_phone: '+13125550142',
    created_at: 1790870333466
};

function fakeTokens() {
    let n = 1;
    const tokens = {
        refreshed: 0,
        purposes: [],
        get: async (purpose) => {
            tokens.purposes.push(purpose);
            return { token: 'site-' + n, expires_at: Date.now() + 600000 };
        },
        refresh: async (purpose) => {
            tokens.purposes.push(purpose);
            n += 1;
            tokens.refreshed += 1;
            return { token: 'site-' + n, expires_at: Date.now() + 600000 };
        }
    };
    return tokens;
}

describe('contacts API', () => {
    it('lists newest first with the contacts token as a bearer', async () => {
        const fetch = scriptedFetch([() => jsonResponse(200, { data: { contacts: [DANA], total_contacts: 1 } })]);
        const tokens = fakeTokens();
        const api = createContactsApi({ tokens, fetch });
        const page = await api.list({ search: 'dana' });
        assert.deepEqual(tokens.purposes, ['contacts']);

        assert.equal(page.total, 1);
        assert.equal(page.contacts[0].id, DANA.contact_id);
        const url = new URL(fetch.calls[0].url);
        assert.equal(url.origin + url.pathname, BASE);
        assert.equal(url.searchParams.get('search_term'), 'dana');
        assert.equal(url.searchParams.get('sort_by'), 'created_at');
        assert.equal(header(fetch.calls[0].init, 'authorization'), 'Bearer site-1');
    });

    it('retries once with a new token after a 401', async () => {
        const tokens = fakeTokens();
        const fetch = scriptedFetch([
            () => jsonResponse(401, { message: 'expired' }),
            () => jsonResponse(200, { data: { contact: DANA } })
        ]);
        const contact = await createContactsApi({ tokens, fetch }).get(DANA.contact_id);
        assert.equal(contact.first_name, 'Dana');
        assert.equal(tokens.refreshed, 1);
        assert.deepEqual(tokens.purposes, ['contacts', 'contacts']);
        assert.equal(header(fetch.calls[1].init, 'authorization'), 'Bearer site-2');
    });

    it('gives up after the second 401', async () => {
        const fetch = scriptedFetch([() => jsonResponse(401, {}), () => jsonResponse(401, {})]);
        await assert.rejects(createContactsApi({ tokens: fakeTokens(), fetch }).get('x'), { code: 'unauthorized' });
        assert.equal(fetch.calls.length, 2);
    });

    it('finds by exact email, exact E.164 phone, or free text', async () => {
        const empty = () => jsonResponse(200, { data: { contacts: [], total_contacts: 0 } });
        const fetch = scriptedFetch([empty, empty, empty]);
        const api = createContactsApi({ tokens: fakeTokens(), fetch });
        await api.find('Dana@Example.com');
        await api.find('(312) 555-0142');
        await api.find('Reyes');
        assert.equal(new URL(fetch.calls[0].url).searchParams.get('email'), 'Dana@Example.com');
        assert.equal(new URL(fetch.calls[1].url).searchParams.get('phone'), '+13125550142');
        assert.equal(new URL(fetch.calls[1].url).pathname, '/contact/public/contacts/search');
        assert.equal(new URL(fetch.calls[2].url).searchParams.get('search_term'), 'Reyes');
    });

    it('returns null for a 200 with no contact', async () => {
        const fetch = scriptedFetch([() => jsonResponse(200, { data: { status: 200, contact: null } })]);
        assert.equal(await createContactsApi({ tokens: fakeTokens(), fetch }).get('missing'), null);
    });

    it('creates with fields and values, sending only filled fields', async () => {
        const fetch = scriptedFetch([() => jsonResponse(201, { data: { inserted: [{ index: 0, contact_id: DANA.contact_id }], updated: [], rejected: [] } })]);
        const result = await createContactsApi({ tokens: fakeTokens(), fetch }).create({ first_name: ' Dana ', email: '', main_phone: '+13125550142' });
        assert.deepEqual(result, { contact_id: DANA.contact_id, created: true });
        const body = JSON.parse(fetch.calls[0].init.body);
        assert.deepEqual(body.fields, [{ type: 'first_name' }, { type: 'main_phone' }]);
        assert.deepEqual(body.values, [['Dana', '+13125550142']]);
        assert.equal(body.conflict_mode, 'append');
    });

    it('reports an existing match as not created, and a rejected row as an error', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(201, { data: { inserted: [], updated: [{ index: 0, contact_id: DANA.contact_id }], rejected: [] } }),
            () => jsonResponse(201, { data: { inserted: [], updated: [], rejected: [{ index: 0, reasons: ['missing_identifier'] }] } })
        ]);
        const api = createContactsApi({ tokens: fakeTokens(), fetch });
        assert.equal((await api.create({ email: 'dana@example.com' })).created, false);
        await assert.rejects(api.create({ first_name: 'Nobody' }), { code: 'contact_rejected' });
    });

    it('updates top-level standard fields and confirms them by reading back', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(200, { data: { contact_id: DANA.contact_id } }),
            () => jsonResponse(200, { data: { contact: Object.assign({}, DANA, { first_name: 'Danielle' }) } })
        ]);
        const saved = await createContactsApi({ tokens: fakeTokens(), fetch }).update(DANA.contact_id, { first_name: 'Danielle' });
        assert.equal(saved.first_name, 'Danielle');
        assert.equal(fetch.calls[0].init.method, 'PUT');
        assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { first_name: 'Danielle' });
    });

    it('fails loudly when an update was accepted but did not stick', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(200, { data: { contact_id: DANA.contact_id } }),
            () => jsonResponse(200, { data: { contact: DANA } })
        ]);
        await assert.rejects(
            createContactsApi({ tokens: fakeTokens(), fetch }).update(DANA.contact_id, { first_name: 'Danielle' }),
            { code: 'update_not_saved', message: 'Not saved: first_name.' }
        );
    });

    it('sends a typed phone number as E.164 and treats the stored format as equal', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(200, { data: { contact_id: DANA.contact_id } }),
            () => jsonResponse(200, { data: { contact: Object.assign({}, DANA, { main_phone: '+13125550199' }) } })
        ]);
        await createContactsApi({ tokens: fakeTokens(), fetch }).update(DANA.contact_id, { main_phone: '(312) 555-0199' });
        assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { main_phone: '+13125550199' });
    });

    it('refuses an update with nothing to save, without calling the API', async () => {
        const fetch = scriptedFetch([]);
        await assert.rejects(
            createContactsApi({ tokens: fakeTokens(), fetch }).update(DANA.contact_id, {}),
            { code: 'no_updatable_fields' }
        );
        assert.equal(fetch.calls.length, 0);
    });

    it('deletes', async () => {
        const fetch = scriptedFetch([() => jsonResponse(200, { data: { contact_id: DANA.contact_id, deleted_at: 1 } })]);
        await createContactsApi({ tokens: fakeTokens(), fetch }).remove(DANA.contact_id);
        assert.equal(fetch.calls[0].init.method, 'DELETE');
        assert.equal(fetch.calls[0].url, BASE + '/' + DANA.contact_id);
    });

    it('records consent once per channel, on the contact\'s number in E.164', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(201, { data: { consent_id: 'd1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c' } }),
            () => jsonResponse(201, { data: { consent_id: 'a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b' } })
        ]);
        const ids = await createContactsApi({ tokens: fakeTokens(), fetch }).recordConsent(DANA.contact_id, {
            phone_number: '(312) 555-0142',
            channels: ['sms', 'calls'],
            consent_method: 'in_person',
            consent_text: '  I agree to texts and calls from Example Co.  '
        });

        assert.deepEqual(ids, ['d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c', 'a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b']);
        assert.equal(fetch.calls[0].url, BASE + '/' + DANA.contact_id + '/consent');
        assert.equal(fetch.calls[0].init.method, 'POST');
        const bodies = fetch.calls.map((c) => JSON.parse(c.init.body));
        assert.deepEqual(bodies.map((b) => b.consent_type), ['sms_optin', 'tcpa_optin']);
        for (const body of bodies) {
            assert.equal(body.phone_number, '+13125550142');
            assert.equal(body.consent_method, 'in_person');
            assert.equal(body.consent_text, 'I agree to texts and calls from Example Co.');
        }
    });

    it('refuses to record consent with no channel, no wording or no phone, without calling the API', async () => {
        const fetch = scriptedFetch([]);
        const api = createContactsApi({ tokens: fakeTokens(), fetch });
        const base = { phone_number: DANA.main_phone, channels: ['sms'], consent_method: 'phone', consent_text: 'Yes' };
        await assert.rejects(api.recordConsent(DANA.contact_id, { ...base, channels: [] }), { code: 'invalid_request', message: /texts, calls/ });
        await assert.rejects(api.recordConsent(DANA.contact_id, { ...base, channels: ['email'] }), { code: 'invalid_request' });
        await assert.rejects(api.recordConsent(DANA.contact_id, { ...base, consent_text: '   ' }), { code: 'invalid_request', message: /wording/ });
        await assert.rejects(api.recordConsent(DANA.contact_id, { ...base, phone_number: '' }), { code: 'invalid_request', message: /phone number/ });
        assert.equal(fetch.calls.length, 0);
    });

    it('falls back to phone for an unknown consent method', async () => {
        const fetch = scriptedFetch([() => jsonResponse(201, { data: { consent_id: 'd1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c' } })]);
        await createContactsApi({ tokens: fakeTokens(), fetch }).recordConsent(DANA.contact_id, {
            phone_number: DANA.main_phone, channels: ['sms'], consent_method: 'carrier_pigeon', consent_text: 'Yes'
        });
        assert.equal(JSON.parse(fetch.calls[0].init.body).consent_method, 'phone');
    });

    it('turns a network or CORS failure into network_error', async () => {
        const fetch = async () => {
            throw new TypeError('Failed to fetch');
        };
        await assert.rejects(createContactsApi({ tokens: fakeTokens(), fetch }).list(), { code: 'network_error' });
    });

    it('keeps working for a team with no carrier, whose session mint fails with byoc_required', async () => {
        async function fetch(url, init) {
            if (url === '/api/dropcowboy/token') {
                const purpose = JSON.parse(init.body).purpose;
                return purpose === 'contacts'
                    ? jsonResponse(200, { token: 'contacts-1', expires_at: Date.now() + 600000 })
                    : jsonResponse(403, { error: { code: 'byoc_required', message: 'Connect a carrier.' } });
            }
            return jsonResponse(200, { data: { contacts: [DANA], total_contacts: 1 } });
        }
        const tokens = createTokenStore(createTokenProvider({ config: { auth_mode: 'server' }, fetch }));
        await assert.rejects(tokens.get('session'), { code: 'byoc_required' });

        const page = await createContactsApi({ tokens, fetch }).list();
        assert.equal(page.contacts[0].id, DANA.contact_id);
    });
});

describe('changedFields', () => {
    it('keeps only what the user changed, ignoring phone formatting and email case', () => {
        const changes = changedFields(DANA, {
            first_name: 'Dana',
            last_name: 'Reyes-Ortiz',
            email: 'DANA@example.com',
            main_phone: '(312) 555-0142',
            company: ''
        });
        assert.deepEqual(changes, { last_name: 'Reyes-Ortiz' });
    });

    it('includes a field the user cleared', () => {
        assert.deepEqual(changedFields(DANA, { email: '' }), { email: '' });
    });
});

describe('normalizeContact', () => {
    it('falls back to field_data and the first phone number', () => {
        const contact = normalizeContact({
            contact_id: 'd1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c',
            field_data: [{ type: 'company', value: 'Acme' }, { type: 'first_name', value: 'Sam' }],
            phone_numbers: ['+13125550187']
        });
        assert.equal(contact.first_name, 'Sam');
        assert.equal(contact.company, 'Acme');
        assert.equal(contact.main_phone, '+13125550187');
    });
});
