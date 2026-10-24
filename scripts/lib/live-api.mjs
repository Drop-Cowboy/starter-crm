// A small client for the real Drop Cowboy API, used by `npm run test:live`
// and `npm run test:live:sweep`.
//
// Where it sits: test-live.mjs (the runner), test-live-sweep.mjs (the
// cleaner) and tests/e2e/support/live.js (the Playwright fixtures) all talk to
// the E2E team through this one file, so a change in the API shape is fixed in
// one place. It is test tooling: the starter server never imports it.
//
// Contract: it uses only routes the starter itself uses (CONTRACT.md "Routes"
// lists the token mint; the contacts and webhooks routes are the public Drop
// Cowboy API). It never sends a text, places a call, rents a number or buys
// anything: contacts and webhooks are all it creates.
//
// What a customer changes: nothing. This is how the maintainers test the
// starter against their own account; run `npm run test:live` against yours
// with STARTER_CRM_LIVE_* set in a git-ignored `.env.live`.

import fs from 'node:fs';
import path from 'node:path';

/** Run ids look like `live-1a2b3c4d`. Every record a live run makes carries one. */
export const RUN_ID_PATTERN = /live-[0-9a-f]{8}/i;

/**
 * Reads `KEY=value` lines from a git-ignored file into `env` without
 * overriding what is already set, so a CI secret always wins over a file.
 *
 * @param {string} file Absolute path. A missing file is fine.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadDotEnv(file, env = process.env) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (env[key] === undefined) env[key] = value;
    }
}

/**
 * Reads the live credentials. Returns `null` when any is missing so callers
 * can stop with a clear message instead of faking a run.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ apiKey: string, apiSecret: string, siteId: string, apiBase: string, userId: string } | null}
 */
export function liveCredentials(env = process.env) {
    const apiKey = env.STARTER_CRM_LIVE_API_KEY;
    const apiSecret = env.STARTER_CRM_LIVE_API_SECRET;
    const siteId = env.STARTER_CRM_LIVE_SITE_ID;
    if (!apiKey || !apiSecret || !siteId) return null;
    return {
        apiKey,
        apiSecret,
        siteId,
        apiBase: (env.DROPCOWBOY_API_BASE || 'https://api-v2.dropcowboy.com').replace(/\/+$/, ''),
        // Any stable UUID: it only attributes minted tokens to "a user".
        userId: env.STARTER_CRM_USER_ID || '8b6f4c2a-1d3e-4f5a-9b7c-0e2d4f6a8c1e'
    };
}

/** A Drop Cowboy error with the status and a short, secret-free message. */
export class LiveApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * The E2E team's API. Contacts go through a minted `contacts` site token (the
 * same path the browser uses; the team's API key itself holds only the scopes
 * it needs to mint and to manage webhooks). Webhooks use the key and secret.
 */
export class LiveApi {
    /**
     * @param {{ apiKey: string, apiSecret: string, siteId: string, apiBase: string, userId: string }} credentials
     * @param {typeof fetch} [fetchImpl]
     */
    constructor(credentials, fetchImpl = globalThis.fetch) {
        this.credentials = credentials;
        this.fetch = fetchImpl;
        this.token = null;
        this.tokenExpiresAt = 0;
    }

    /**
     * A `contacts` site token, minted on first use and again 60 s before it
     * expires. The token is held in memory only and is never printed.
     *
     * @returns {Promise<string>}
     */
    async contactsToken() {
        if (this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;
        const { apiBase, apiKey, apiSecret, siteId, userId } = this.credentials;
        const response = await this.fetch(apiBase + '/phone/public/embed/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-key': apiKey, 'x-secret': apiSecret },
            body: JSON.stringify({ site_id: siteId, sub: userId, scope: ['contacts'], ttl_seconds: 900 })
        });
        const body = await readJson(response);
        if (!response.ok) throw new LiveApiError(response.status, 'mint failed: ' + problemText(response.status, body));
        const grant = body.data || body;
        this.token = grant.token;
        this.tokenExpiresAt = Number(grant.expires_at) || Date.now() + 900000;
        return this.token;
    }

    /**
     * One request with the contacts token.
     *
     * @param {string} method
     * @param {string} route Path and query, starting with `/`.
     * @param {object} [body]
     * @returns {Promise<any>} The `data` member of the answer.
     */
    async contacts(method, route, body) {
        const token = await this.contactsToken();
        const response = await this.fetch(this.credentials.apiBase + route, {
            method,
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const payload = await readJson(response);
        if (!response.ok) throw new LiveApiError(response.status, method + ' ' + route.split('?')[0] + ' failed: ' + problemText(response.status, payload));
        return payload.data === undefined ? payload : payload.data;
    }

    /**
     * Creates one contact, optionally on a pipeline stage, and fires the
     * `contact.created` webhook so the activity feed has something to show.
     *
     * @param {{ first_name: string, last_name: string, main_phone: string, email: string, company?: string }} person
     * @param {{ listId?: string }} [options]
     * @returns {Promise<string>} The new contact's id.
     */
    async createContact(person, options = {}) {
        const result = await this.contacts('POST', '/contact/public/contacts', {
            fields: [{ type: 'first_name' }, { type: 'last_name' }, { type: 'email' }, { type: 'main_phone' }, { type: 'company' }],
            values: [[person.first_name, person.last_name, person.email, person.main_phone, person.company || '']],
            add_list_ids: options.listId ? [options.listId] : undefined,
            conflict_mode: 'append',
            fire_webhook_events: true
        });
        const row = (result.inserted || [])[0] || (result.updated || [])[0];
        if (!row) throw new LiveApiError(400, 'create contact: no row came back (' + JSON.stringify(result.rejected || []).slice(0, 200) + ')');
        return row.contact_id;
    }

    /**
     * Changes standard fields on a contact (fires `contact.updated`).
     *
     * @param {string} contactId
     * @param {object} fields For example `{ company: 'New name' }`.
     */
    async updateContact(contactId, fields) {
        await this.contacts('PUT', '/contact/public/contacts/' + contactId, fields);
    }

    /**
     * Records consent on a contact, the same request the starter's consent
     * form sends (shared/contacts-api.js `recordConsent`). The live sandbox
     * specs record it before they call or text a test contact, so the send
     * does not depend on the team's "Use existing contact consent" setting.
     * The record goes when teardown deletes the contact.
     *
     * @param {string} contactId
     * @param {{ consent_type: 'sms_optin' | 'tcpa_optin', phone_number: string, consent_text: string }} consent
     * @returns {Promise<string>} The consent id ('' when none came back).
     */
    async recordConsent(contactId, consent) {
        const data = await this.contacts('POST', '/contact/public/contacts/' + contactId + '/consent', {
            consent_type: consent.consent_type,
            phone_number: consent.phone_number,
            consent_text: consent.consent_text,
            consent_method: 'phone'
        });
        return (data && data.consent_id) || '';
    }

    /**
     * Deletes one contact. A contact that is already gone is not an error, so
     * teardown can run twice.
     *
     * @param {string} contactId
     */
    async deleteContact(contactId) {
        try {
            await this.contacts('DELETE', '/contact/public/contacts/' + contactId);
        } catch (err) {
            if (!(err instanceof LiveApiError) || err.status !== 404) throw err;
        }
    }

    /**
     * A contact as stored, or `null` once it is deleted.
     *
     * @param {string} contactId
     * @returns {Promise<object | null>}
     */
    async getContact(contactId) {
        try {
            const data = await this.contacts('GET', '/contact/public/contacts/' + contactId);
            return data.contact || null;
        } catch (err) {
            if (err instanceof LiveApiError && err.status === 404) return null;
            throw err;
        }
    }

    /**
     * Waits until a free-text search for `term` returns the contact. Search
     * trails a create by a moment.
     *
     * @param {string} contactId
     * @param {string} term
     * @param {number} [timeoutMs]
     * @throws {LiveApiError} When the contact is still not found in time.
     */
    async waitUntilSearchable(contactId, term, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = await this.findContacts(term);
            if (found.some((contact) => contact.contact_id === contactId)) return;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new LiveApiError(504, 'contact ' + contactId + ' was not searchable after ' + Math.round(timeoutMs / 1000) + 's');
    }

    /**
     * Contacts whose name matches `term`, with their creation time.
     *
     * @param {string} term
     * @returns {Promise<{ contact_id: string, name: string, created_at: number }[]>}
     */
    async findContacts(term) {
        const found = [];
        for (let offset = 0; offset < 1000; offset += 100) {
            const data = await this.contacts('GET', '/contact/public/contacts?limit=100&offset=' + offset
                + '&search_term=' + encodeURIComponent(term));
            const page = data.contacts || [];
            for (const contact of page) {
                found.push({
                    contact_id: contact.contact_id,
                    name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
                    created_at: Number(contact.created_at) || 0
                });
            }
            if (page.length < 100) break;
        }
        return found;
    }

    /**
     * Deletes every contact whose name carries a run id, optionally only
     * those created before `olderThanMs`. Returns what it deleted.
     *
     * @param {{ runId?: string, olderThanMs?: number }} [options] Omit `runId` to match any run.
     * @returns {Promise<{ contact_id: string, name: string }[]>}
     */
    async deleteRunContacts({ runId, olderThanMs } = {}) {
        const matched = await this.findContacts(runId || 'live-');
        const removed = [];
        for (const contact of matched) {
            const owned = runId ? contact.name.includes(runId) : RUN_ID_PATTERN.test(contact.name);
            if (!owned) continue;
            if (olderThanMs && contact.created_at && contact.created_at > olderThanMs) continue;
            await this.deleteContact(contact.contact_id);
            removed.push({ contact_id: contact.contact_id, name: contact.name });
        }
        return removed;
    }

    /**
     * The first pipeline and its stages, for the pipeline specs.
     *
     * @returns {Promise<{ board_id: string, name: string, stages: { list_id: string, name: string }[] }>}
     */
    async firstBoard() {
        const boards = await this.contacts('GET', '/boards/public/boards');
        const list = Array.isArray(boards) ? boards : (boards.boards || []);
        if (!list.length) throw new LiveApiError(404, 'the E2E team has no pipeline');
        const snapshot = await this.contacts('GET', '/boards/public/pipelines/' + list[0].board_id + '/snapshot');
        return {
            board_id: snapshot.board_id,
            name: snapshot.name,
            stages: (snapshot.stages || []).map((stage) => ({ list_id: stage.list_id, name: stage.name }))
        };
    }

    /**
     * Registers a webhook for the run. The signing secret is returned once.
     *
     * @param {{ url: string, name: string, events: string[] }} options
     * @returns {Promise<{ id: string, signingSecret: string }>}
     */
    async createWebhook({ url, name, events }) {
        const { apiBase, apiKey, apiSecret } = this.credentials;
        const response = await this.fetch(apiBase + '/register/public/webhooks', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-key': apiKey, 'x-secret': apiSecret },
            body: JSON.stringify({ hook_url: url, name, event_types: events })
        });
        const body = await readJson(response);
        if (!response.ok) throw new LiveApiError(response.status, 'register webhook failed: ' + problemText(response.status, body));
        const created = body.data || body;
        return { id: created.webhook_id || created.id, signingSecret: created.signing_secret || created.secret };
    }

    /**
     * Deletes a webhook. Already gone counts as deleted.
     *
     * @param {string} id
     */
    async deleteWebhook(id) {
        const { apiBase, apiKey, apiSecret } = this.credentials;
        const response = await this.fetch(apiBase + '/register/public/webhooks/' + id, {
            method: 'DELETE',
            headers: { 'x-key': apiKey, 'x-secret': apiSecret }
        });
        if (!response.ok && response.status !== 404) {
            throw new LiveApiError(response.status, 'delete webhook failed: ' + problemText(response.status, await readJson(response)));
        }
    }
}

/**
 * Where a live run records the webhook it registered. If the run dies before
 * teardown, `npm run test:live:sweep` reads this folder and deletes the
 * webhook by id (the E2E key can delete a webhook but not list them).
 *
 * @param {string} root The starter root.
 * @returns {string}
 */
export function liveStateDir(root) {
    return path.join(root, '.live-state');
}

/** A short, secret-free description of an API error body. */
function problemText(status, body) {
    const detail = body && (body.detail || body.message || body.title);
    return 'HTTP ' + status + (typeof detail === 'string' ? ' ' + detail.slice(0, 200) : '');
}

async function readJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return { detail: text.slice(0, 200) };
    }
}
