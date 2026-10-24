/**
 * Helpers every module-data provider shares, so the built-in providers (and yours)
 * agree on the parts of the data API that are easy to get subtly different.
 *
 * Where it sits: memory.js, sqlite.js and postgres.js import these. The rules live in
 * one place on purpose: a provider that disagreed about which field names are allowed, or
 * how a list is ordered, would pass its own tests and still behave differently from the
 * others when a customer changes `DC_DATA`.
 *
 * CONTRACT.md: "Module data".
 * What a customer changes: nothing; when you write your own data provider, import these
 * instead of re-deriving them.
 */

import { randomUUID } from 'node:crypto';

/** What a collection name may look like: lowercase letters, digits and underscores, starting with a letter. */
const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** What a field name in a `where` filter may look like. It is put into SQL text, so it must be this strict. */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The fields the data API owns. A module cannot set them, so a document's id, owner and times can be trusted. */
export const RESERVED_FIELDS = Object.freeze(['id', 'owner_id', 'created_at', 'updated_at']);

/** The most documents one `list()` returns, and what it returns when no limit is given. */
export const LIST_MAX = 500;
export const LIST_DEFAULT = 100;

/** The methods a custom `DC_DATA` provider's instance must have; boot checks for them. */
export const DATA_METHODS = Object.freeze(['scope', 'system', 'ready', 'close']);

/**
 * Makes a new document id.
 *
 * @returns {string} A random UUID, with no prefix.
 */
export function newId() {
    return randomUUID();
}

/**
 * Checks a collection name.
 *
 * @param {unknown} name What the module passed to `collection()`.
 * @returns {string} The same name.
 * @throws {Error} When it is not lowercase letters, digits and underscores.
 */
export function checkCollection(name) {
    if (typeof name !== 'string' || !COLLECTION_NAME.test(name)) {
        throw new Error('A collection name is lowercase letters, digits and underscores, starting with a letter (got ' + JSON.stringify(name) + ').');
    }
    return name;
}

/**
 * Checks the fields of a new document or an update, and drops `undefined` values.
 *
 * @param {unknown} fields What the module passed to `insert()` or `update()`.
 * @param {string[]} [allowed] Reserved names the caller may include (the system view sets `owner_id` itself).
 * @returns {Record<string, unknown>} A copy that survives `JSON.stringify` unchanged.
 * @throws {Error} When it is not an object, or sets a field only the data API may set.
 */
export function checkFields(fields, allowed = []) {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new Error('A document is a plain object.');
    }
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
        if (RESERVED_FIELDS.includes(key) && !allowed.includes(key)) {
            throw new Error('"' + key + '" is set by the data API; leave it out of the document.');
        }
        if (value !== undefined) out[key] = value;
    }
    return JSON.parse(JSON.stringify(out));
}

/**
 * Checks a `where` filter: field names that are safe to use in SQL, and values that are strings, numbers or booleans.
 *
 * @param {unknown} where The filter, or undefined for none.
 * @returns {[string, string|number|boolean][]} The entries to match, in the order given.
 * @throws {Error} For an unsafe field name, or a value that is not a string, finite number or boolean.
 */
export function checkWhere(where) {
    if (where === undefined || where === null) return [];
    if (typeof where !== 'object' || Array.isArray(where)) throw new Error('`where` is an object of field: value pairs.');
    const out = [];
    for (const [key, value] of Object.entries(where)) {
        if (!FIELD_NAME.test(key) || RESERVED_FIELDS.includes(key)) {
            throw new Error('Cannot filter on "' + key + '": use a document field name in lowercase letters, digits and underscores.');
        }
        const kind = typeof value;
        if (kind !== 'string' && kind !== 'boolean' && !(kind === 'number' && Number.isFinite(value))) {
            throw new Error('Filter "' + key + '" must be a string, a number or a boolean.');
        }
        out.push([key, value]);
    }
    return out;
}

/**
 * Clamps a list limit.
 *
 * @param {number|undefined} limit What the module asked for.
 * @returns {number} A whole number from 1 to LIST_MAX; LIST_DEFAULT when unset or invalid.
 */
export function listLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1) return LIST_DEFAULT;
    return Math.min(limit, LIST_MAX);
}

/**
 * Writes an epoch time the way documents show it.
 *
 * @param {number} ms Epoch milliseconds.
 * @returns {string} ISO 8601 in UTC with milliseconds, such as `2026-10-13T12:00:00.000Z`.
 */
export function isoTime(ms) {
    return new Date(Number(ms)).toISOString();
}

/**
 * Builds the document a module sees from a stored row.
 *
 * @param {{ id: string, owner_id: string, created_at: number|string, updated_at: number|string }} row The columns.
 * @param {Record<string, unknown>} fields The JSON the module stored.
 * @returns {object} `id`, `owner_id`, `created_at` and `updated_at` first, then the module's fields.
 */
export function toDocument(row, fields) {
    // The module's fields cannot be listed here, so they are copied over the four the data API owns.
    return Object.assign({
        id: row.id,
        owner_id: row.owner_id,
        created_at: isoTime(row.created_at),
        updated_at: isoTime(row.updated_at)
    }, fields);
}

/**
 * Builds the owner-bound and system views of a provider from its row operations.
 *
 * Every provider supplies the same six row operations, and this wraps them so the checks, the
 * owner rule and the document shape are written once. A collection from `scope(ownerId)` can only
 * ever see that owner's rows, because the owner is part of every operation here, not something the
 * module passes. A collection from `system()` sees every owner of the site; only event handlers
 * (such as archiving a deleted contact's deals) and the scaffolded jobs get it.
 *
 * @param {{ insert: Function, get: Function, list: Function, update: Function, remove: Function }} rows
 *   The provider's row operations, each taking `(collection, owner|null, ...)`.
 * @returns {{ scope: (ownerId: string) => { collection: Function }, system: () => { collection: Function } }} The two views.
 * @throws {Error} From `scope()` when the owner id is not a non-empty string.
 */
export function buildViews(rows) {
    /**
     * Makes the collection function for one owner (null means every owner).
     *
     * @param {string|null} owner The owner every operation is limited to, or null for the system view.
     * @returns {{ collection: (name: string) => object }} The view.
     */
    function view(owner) {
        return {
            collection(name) {
                checkCollection(name);
                return {
                    async insert(fields) {
                        const clean = checkFields(fields, owner === null ? ['owner_id'] : []);
                        const ownerId = owner === null ? clean.owner_id : owner;
                        if (typeof ownerId !== 'string' || ownerId === '') throw new Error('A document in the system view needs an owner_id.');
                        delete clean.owner_id;
                        return rows.insert(name, ownerId, clean);
                    },
                    async get(id) {
                        return rows.get(name, owner, String(id));
                    },
                    async list({ where, limit } = {}) {
                        return rows.list(name, owner, checkWhere(where), listLimit(limit));
                    },
                    async update(id, patch) {
                        return rows.update(name, owner, String(id), checkFields(patch));
                    },
                    async remove(id) {
                        return rows.remove(name, owner, String(id));
                    }
                };
            }
        };
    }

    return {
        scope(ownerId) {
            if (typeof ownerId !== 'string' || ownerId === '') throw new Error('scope() needs the signed-in user\'s id.');
            return view(ownerId);
        },
        system() {
            return view(null);
        }
    };
}
