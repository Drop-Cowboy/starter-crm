/**
 * The `memory` data provider: module documents live in this process and vanish on restart.
 *
 * Where it sits: `DC_DATA=memory`, which is also what `DC_STORE=memory` (the default)
 * selects. Nothing to install, and the data API behaves exactly as it will on a database, so
 * you can build a module against it and move to `sqlite` or `postgres` by changing one
 * setting. It cannot be shared between instances.
 *
 * The data interface (every provider, built-in or yours, implements it):
 * - `scope(ownerId)` -> `{ collection(name) }`: a view that only ever sees that owner's documents.
 * - `system()` -> `{ collection(name) }`: a view over every owner of the site, for event handlers.
 * - A collection has `insert(fields)`, `get(id)`, `list({ where, limit })`, `update(id, patch)` and
 *   `remove(id)`. A document is `{ id, owner_id, created_at, updated_at, ...yourFields }`. `get`
 *   returns null for a missing document, and also for another owner's: a module cannot tell the two apart.
 * - `ready()`, `close()` and (SQL providers) `appliedMigrations()`.
 * All of them return promises, so a provider backed by a network service fits the same shape.
 *
 * CONTRACT.md: "Module data".
 * What a customer changes: nothing; to keep documents across restarts set `DC_DATA`.
 */

import { buildViews, newId, toDocument } from './common.js';

export const name = 'memory';
export const configKeys = [];

/**
 * Nothing to configure.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Whether a stored field equals a filter value, with no JavaScript coercion.
 *
 * @param {unknown} stored What the document holds.
 * @param {string|number|boolean} wanted What the filter asks for.
 * @returns {boolean} True when they are the same type and value.
 */
function same(stored, wanted) {
    return typeof stored === typeof wanted && stored === wanted;
}

/**
 * Creates the provider.
 *
 * @param {{ config: object, now?: () => number }} ctx Provider context; `now` is replaced in tests.
 * @returns {object} The provider instance (see the interface in this file's header).
 */
export function create(ctx) {
    const now = ctx.now || Date.now;
    // collection name -> id -> row. One process serves one site, so the site is not part of the key here.
    const tables = new Map();

    /**
     * Finds or makes the table for a collection.
     *
     * @param {string} collection The collection name.
     * @returns {Map<string, object>} Its rows by id.
     */
    function table(collection) {
        if (!tables.has(collection)) tables.set(collection, new Map());
        return tables.get(collection);
    }

    /**
     * Reads a row the caller may see.
     *
     * @param {string} collection The collection.
     * @param {string|null} owner The owner to limit to, or null for any.
     * @param {string} id The document id.
     * @returns {object|null} The row, or null when it is missing or another owner's.
     */
    function visible(collection, owner, id) {
        const row = table(collection).get(id);
        return row && (owner === null || row.owner_id === owner) ? row : null;
    }

    const rows = {
        async insert(collection, owner, fields) {
            const at = now();
            const row = { id: newId(), owner_id: owner, created_at: at, updated_at: at, fields };
            table(collection).set(row.id, row);
            return toDocument(row, structuredClone(fields));
        },

        async get(collection, owner, id) {
            const row = visible(collection, owner, id);
            return row ? toDocument(row, structuredClone(row.fields)) : null;
        },

        async list(collection, owner, where, limit) {
            const found = [];
            for (const row of table(collection).values()) {
                if (owner !== null && row.owner_id !== owner) continue;
                if (where.every(([key, value]) => same(row.fields[key], value))) found.push(row);
            }
            found.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
            return found.slice(0, limit).map((row) => toDocument(row, structuredClone(row.fields)));
        },

        async update(collection, owner, id, patch) {
            const row = visible(collection, owner, id);
            if (!row) return null;
            // The fields are the module's own, so they cannot be listed here: merge whatever the patch names.
            row.fields = Object.assign({}, row.fields, structuredClone(patch));
            // Never earlier than the creation time, even when the clock steps back.
            row.updated_at = Math.max(now(), row.created_at);
            return toDocument(row, structuredClone(row.fields));
        },

        async remove(collection, owner, id) {
            return visible(collection, owner, id) ? table(collection).delete(id) : false;
        }
    };

    const views = buildViews(rows);
    return {
        scope: views.scope,
        system: views.system,
        async ready() {
            return true;
        },
        async close() {
            tables.clear();
        }
    };
}
