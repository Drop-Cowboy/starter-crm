/**
 * The Deals module: the worked example of a Starter CRM module, end to end.
 *
 * Where it sits: a deal is a thing you are selling, optionally tied to a Drop Cowboy contact.
 * The browser's Deals page calls these routes; the data lives in the `deals` collection of the data
 * API (`DC_DATA`), so every deal belongs to the user who made it and nobody else can read or change it.
 * When Drop Cowboy tells this server a contact was deleted, `onEvent` archives that contact's deals, so the
 * page no longer shows a deal for a person who asked to be forgotten.
 *
 * Routes (all need a signed-in user; creates and updates are POST, deletes are DELETE):
 * - `GET    /api/modules/deals`      list this user's deals, newest first. Filters: `stage`, `contact_id`,
 *                                    `archived=true|false|all` (default false).
 * - `POST   /api/modules/deals`      create one: `{ title, contact_id?, amount_cents?, currency?, stage?, notes? }`.
 * - `GET    /api/modules/deals/:id`  read one.
 * - `POST   /api/modules/deals/:id`  change some fields of one.
 * - `DELETE /api/modules/deals/:id`  delete one for good.
 *
 * The request shapes are in `server/schemas/deals.json`, shared with the Python server, so both reject
 * the same input with `400 invalid_request` and the name of the field.
 *
 * CONTRACT.md: "Modules" (Deals).
 * To make your own: `npm run new:module -- tickets` copies this folder and renames it; see CUSTOMIZE.md.
 */

import { HttpError } from '../../errors.js';
import { checkBody, loadSchemas } from '../../validate.js';

/** The data API collection this module keeps its documents in. */
const COLLECTION = 'deals';

/** A safety stop on the archive loop below: 1000 passes of 100 deals, never reached in practice. */
const MAX_ARCHIVE_PASSES = 1000;

const schemas = loadSchemas('deals');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The error for a deal that is not there, or is not this user's: the two look the same on purpose.
 *
 * @returns {HttpError} 404 `deal_not_found`.
 */
function missing() {
    return new HttpError(404, 'deal_not_found', 'No deal with that id.');
}

/**
 * Reads a deal id from the path. Anything that is not a UUID cannot be a deal, so it never reaches the database.
 *
 * @param {Record<string, string>} params The route parameters.
 * @returns {string} The id.
 * @throws {HttpError} 404 `deal_not_found` for something that is not a UUID.
 */
function dealId(params) {
    if (!UUID.test(params.id)) throw missing();
    return params.id;
}

export default {
    id: 'deals',

    routes(router) {
        router.get('/', async (ctx) => {
            checkBody(schemas.query, ctx.query);
            const where = {};
            if (ctx.query.stage) where.stage = ctx.query.stage;
            if (ctx.query.contact_id) where.contact_id = ctx.query.contact_id.toLowerCase();
            if (ctx.query.archived !== 'all') where.archived = ctx.query.archived === 'true';
            return { deals: await ctx.data.collection(COLLECTION).list({ where }) };
        });

        router.post('/', { body: schemas.create }, async (ctx) => {
            const body = ctx.body;
            const deal = await ctx.data.collection(COLLECTION).insert({
                title: body.title,
                contact_id: body.contact_id ? body.contact_id.toLowerCase() : null,
                amount_cents: body.amount_cents ?? 0,
                currency: body.currency ?? 'USD',
                stage: body.stage ?? 'lead',
                notes: body.notes ?? '',
                archived: false,
                archived_reason: null
            });
            return ctx.reply(201, { deal });
        });

        router.get('/:id', async (ctx) => {
            const deal = await ctx.data.collection(COLLECTION).get(dealId(ctx.params));
            if (!deal) throw missing();
            return { deal };
        });

        router.post('/:id', { body: schemas.update }, async (ctx) => {
            const changes = {};
            for (const key of Object.keys(ctx.body)) {
                changes[key] = key === 'contact_id' && ctx.body[key] ? ctx.body[key].toLowerCase() : ctx.body[key];
            }
            // A person who archives or restores a deal also settles why it is archived.
            if (Object.hasOwn(changes, 'archived')) changes.archived_reason = changes.archived ? 'manual' : null;
            const deal = await ctx.data.collection(COLLECTION).update(dealId(ctx.params), changes);
            if (!deal) throw missing();
            return { deal };
        });

        router.delete('/:id', async (ctx) => {
            const id = dealId(ctx.params);
            if (!await ctx.data.collection(COLLECTION).remove(id)) throw missing();
            return { deleted: true, id };
        });
    },

    onEvent: {
        /**
         * Archives every deal tied to a contact Drop Cowboy says was deleted. Safe to run twice: an archived deal is skipped.
         *
         * @param {{ data: { contact_id?: string } }} event The `contact.deleted` event.
         * @param {{ data: object, log: object }} ctx The event context; `data` sees every owner.
         * @returns {Promise<void>}
         */
        'contact.deleted': async (event, ctx) => {
            const contactId = event.data && typeof event.data.contact_id === 'string' ? event.data.contact_id.toLowerCase() : null;
            if (!contactId) return;
            const deals = ctx.data.collection(COLLECTION);
            let archived = 0;
            for (let pass = 0; pass < MAX_ARCHIVE_PASSES; pass++) {
                const page = await deals.list({ where: { contact_id: contactId, archived: false }, limit: 100 });
                if (page.length === 0) break;
                for (const deal of page) {
                    await deals.update(deal.id, { archived: true, archived_reason: 'contact_deleted' });
                    archived++;
                }
            }
            if (archived > 0) await ctx.log.info('Archived ' + archived + ' deal(s) for deleted contact ' + contactId + '.');
        }
    }
};
