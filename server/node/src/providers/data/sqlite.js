/**
 * The `sqlite` data provider: module documents in one file on disk.
 *
 * Where it sits: `DC_DATA=sqlite`, which is also what `DC_STORE=sqlite` selects. It opens
 * the same file as the event store (`DC_SQLITE_PATH`, default `data/starter-crm.sqlite`
 * under the starter root), so one file holds everything and one copy backs it all up. It uses
 * Node's built-in `node:sqlite` with the write-ahead log on. Documents are rows of
 * `starter_crm_data`, created by server/migrations/sqlite/002_module_data.sql, which the Python
 * server shares: either server can open the other's file.
 *
 * SQLite allows one writer at a time and cannot be shared across machines, so run one
 * instance; use `postgres` to scale out.
 *
 * CONTRACT.md: "Module data".
 * Env: DC_SQLITE_PATH. What a customer changes: nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { migrateSqlite } from '../../migrations.js';
import { siteKey } from '../store/common.js';
import { buildViews, newId, toDocument } from './common.js';

export const name = 'sqlite';
export const configKeys = ['DC_SQLITE_PATH'];

/**
 * Nothing beyond the path, which has a default; the folder is created at start.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Turns a database row into a document.
 *
 * @param {object} row A row of starter_crm_data.
 * @returns {object} The document.
 */
function fromRow(row) {
    return toDocument(row, JSON.parse(row.data));
}

/**
 * Opens the database, creates its folder and applies migrations.
 *
 * @param {{ config: object, now?: () => number }} ctx Provider context; `now` is replaced in tests.
 * @returns {Promise<object>} The provider (see the interface in memory.js).
 */
export async function create(ctx) {
    // The built-in module is only needed when this provider is chosen, so it is not imported at the top of the file.
    const { DatabaseSync } = await import('node:sqlite');
    const now = ctx.now || Date.now;
    const site = siteKey(ctx.config);
    const file = path.resolve(ctx.config.root, ctx.config.events.sqlitePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    // The same file and the same trade-off as the event store; see providers/store/sqlite.js.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    migrateSqlite(db);

    const sql = {
        insert: db.prepare('INSERT INTO starter_crm_data (site_id, collection, id, owner_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
        get: db.prepare('SELECT * FROM starter_crm_data WHERE site_id = ? AND collection = ? AND id = ?'),
        save: db.prepare('UPDATE starter_crm_data SET data = ?, updated_at = ? WHERE site_id = ? AND collection = ? AND id = ?'),
        remove: db.prepare('DELETE FROM starter_crm_data WHERE site_id = ? AND collection = ? AND id = ?')
    };

    /**
     * Reads one row the caller may see.
     *
     * @param {string} collection The collection.
     * @param {string|null} owner The owner to limit to, or null for any.
     * @param {string} id The document id.
     * @returns {object|undefined} The row, or undefined when it is missing or another owner's.
     */
    function visible(collection, owner, id) {
        const row = sql.get.get(site, collection, id);
        return row && (owner === null || row.owner_id === owner) ? row : undefined;
    }

    const rows = {
        async insert(collection, owner, fields) {
            const at = now();
            const id = newId();
            sql.insert.run(site, collection, id, owner, JSON.stringify(fields), at, at);
            return fromRow(sql.get.get(site, collection, id));
        },

        async get(collection, owner, id) {
            const row = visible(collection, owner, id);
            return row ? fromRow(row) : null;
        },

        async list(collection, owner, where, limit) {
            let text = 'SELECT * FROM starter_crm_data WHERE site_id = ? AND collection = ?';
            const params = [site, collection];
            if (owner !== null) {
                text += ' AND owner_id = ?';
                params.push(owner);
            }
            for (const [key, value] of where) {
                // The field name was checked to be plain characters, and is bound as a JSON path, never put into the SQL.
                // SQLite stores true as 1, so the JSON type is checked too: filtering on 1 must not find true.
                const types = typeof value === 'boolean' ? "('true', 'false')" : (typeof value === 'number' ? "('integer', 'real')" : "('text')");
                text += ' AND json_type(data, ?) IN ' + types + ' AND json_extract(data, ?) = ?';
                params.push('$.' + key, '$.' + key, typeof value === 'boolean' ? Number(value) : value);
            }
            text += ' ORDER BY created_at DESC, id DESC LIMIT ?';
            params.push(limit);
            return db.prepare(text).all(...params).map(fromRow);
        },

        async update(collection, owner, id, patch) {
            // Read, merge and write inside one write transaction, so two writers cannot lose each other's change.
            db.exec('BEGIN IMMEDIATE');
            try {
                const row = visible(collection, owner, id);
                if (!row) {
                    db.exec('COMMIT');
                    return null;
                }
                // The fields are the module's own, so they cannot be listed here: merge whatever the patch names.
                const merged = Object.assign({}, JSON.parse(row.data), patch);
                sql.save.run(JSON.stringify(merged), Math.max(now(), row.created_at), site, collection, id);
                db.exec('COMMIT');
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
            return fromRow(sql.get.get(site, collection, id));
        },

        async remove(collection, owner, id) {
            if (!visible(collection, owner, id)) return false;
            return sql.remove.run(site, collection, id).changes === 1;
        }
    };

    const views = buildViews(rows);
    return {
        scope: views.scope,
        system: views.system,

        async appliedMigrations() {
            return db.prepare('SELECT name FROM starter_crm_migrations ORDER BY name').all().map((row) => row.name);
        },

        async ready() {
            try {
                db.prepare('SELECT 1').get();
                return true;
            } catch {
                return false;
            }
        },

        async close() {
            db.close();
        }
    };
}
