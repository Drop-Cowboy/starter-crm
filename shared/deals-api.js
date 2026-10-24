import { callServer } from './server-api.js';

// The Deals module's API on the Starter CRM server (server/CONTRACT.md, "Modules").
// Deals are documents the server keeps for the signed-in user; Drop Cowboy never sees them.
// A deal may point at a contact by id, which is how the page shows the contact card.
//
// This file is the one place the front-ends learn what a deal looks like, so the vanilla and
// React pages never disagree. To build your own module, copy it (`npm run new:module -- tickets`
// copies the server side; copy this file and the two pages to match).

export const DEAL_STAGES = [
    { id: 'lead', label: 'Lead' },
    { id: 'qualified', label: 'Qualified' },
    { id: 'proposal', label: 'Proposal' },
    { id: 'won', label: 'Won' },
    { id: 'lost', label: 'Lost' }
];

const BASE = '/api/modules/deals';

/**
 * @typedef {object} Deal
 * @property {string} id
 * @property {string} title
 * @property {string | null} contact_id
 * @property {number} amount_cents
 * @property {string} currency        ISO 4217, such as "USD"
 * @property {'lead' | 'qualified' | 'proposal' | 'won' | 'lost'} stage
 * @property {string} notes
 * @property {boolean} archived
 * @property {'manual' | 'contact_deleted' | null} archived_reason
 * @property {string} created_at      ISO 8601
 * @property {string} updated_at      ISO 8601
 */

/**
 * Whether this server mode runs modules. They need a signed-in user, which only server mode has.
 *
 * @param {{ auth_mode?: string } | null | undefined} config  The app config from GET /api/config.
 * @returns {boolean}
 */
export function dealsAvailable(config) {
    return Boolean(config) && config.auth_mode === 'server';
}

/**
 * Creates the Deals API client.
 *
 * @param {{ call?: typeof callServer }} [options]  `call` replaces the server call in tests.
 */
export function createDealsApi(options) {
    const call = (options && options.call) || callServer;

    return {
        /**
         * @param {{ stage?: string, archived?: boolean | 'all', contactId?: string }} [filter]
         * @returns {Promise<Deal[]>} Newest first.
         */
        async list(filter) {
            const query = new URLSearchParams();
            const f = filter || {};
            if (f.stage) {
                query.set('stage', f.stage);
            }
            if (f.contactId) {
                query.set('contact_id', f.contactId);
            }
            if (typeof f.archived === 'boolean' || f.archived === 'all') {
                query.set('archived', String(f.archived));
            }
            const text = query.toString();
            const data = await call(BASE + (text ? '?' + text : ''));
            return data.deals;
        },

        /** @returns {Promise<Deal>} */
        async create(input) {
            return (await call(BASE, { method: 'POST', body: input })).deal;
        },

        /** @returns {Promise<Deal>} */
        async update(id, changes) {
            return (await call(BASE + '/' + encodeURIComponent(id), { method: 'POST', body: changes })).deal;
        },

        /** @returns {Promise<void>} */
        async remove(id) {
            await call(BASE + '/' + encodeURIComponent(id), { method: 'DELETE' });
        }
    };
}

/**
 * Turns what a person types into cents. "12.5" is 1250; blank is 0. Returns null for anything that is not a
 * non-negative amount with at most two decimals, so the form can say so before the server does.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function parseAmount(text) {
    const value = String(text === undefined || text === null ? '' : text).trim().replace(/,/g, '');
    if (value === '') {
        return 0;
    }
    const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) {
        return null;
    }
    return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

/**
 * "$1,250.00" for 125000 cents.
 *
 * @param {number} cents
 * @param {string} [currency]
 * @returns {string}
 */
export function formatAmount(cents, currency) {
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format((cents || 0) / 100);
    } catch {
        return ((cents || 0) / 100).toFixed(2) + ' ' + currency;
    }
}

/**
 * @param {string} stageId
 * @returns {string} The label for a stage id, or the id itself for one this page does not know.
 */
export function stageLabel(stageId) {
    const found = DEAL_STAGES.find((stage) => stage.id === stageId);
    return found ? found.label : String(stageId);
}

/**
 * Why a deal is archived, in words.
 *
 * @param {Deal} deal
 * @returns {string} An empty string for a deal that is not archived.
 */
export function archivedNote(deal) {
    if (!deal.archived) {
        return '';
    }
    return deal.archived_reason === 'contact_deleted' ? 'Archived: its contact was deleted in Drop Cowboy' : 'Archived';
}
