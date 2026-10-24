/**
 * The `postgres` data provider: module documents in a Postgres table every instance shares.
 *
 * Where it sits: `DC_DATA=postgres`, which is also what `DC_STORE=postgres` selects, with the
 * connection string in `DC_DATABASE_URL` (or `DATABASE_URL`). This is the provider for more than
 * one instance, and the one to back up with your host's point-in-time recovery. Documents are
 * rows of `starter_crm_data` with a `jsonb` column, created by
 * server/migrations/postgres/002_module_data.sql under the same advisory lock as the event
 * store's tables. The Python server shares the table.
 *
 * A `where` filter becomes jsonb containment (`data @> {"stage":"won"}`), so it matches the
 * value's type exactly: the string `"1"` does not match the number `1`.
 *
 * CONTRACT.md: "Module data".
 * Env: DC_DATABASE_URL, DATABASE_URL or NETLIFY_DB_URL. What a customer changes: nothing.
 */

import { migratePostgres } from '../../migrations.js';
import { problem } from '../../problems.js';
import { siteKey } from '../store/common.js';
import * as postgresStore from '../store/postgres.js';
import { buildViews, newId, toDocument } from './common.js';

export const name = 'postgres';
export const configKeys = ['DC_DATABASE_URL', 'DATABASE_URL', 'NETLIFY_DB_URL'];

/**
 * Checks the connection string the way the event store does, so a bad URL is reported once, not once per piece.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    if (!postgresStore.databaseUrl(env)) {
        return [problem('missing_database_url', 'DC_DATA=postgres needs DC_DATABASE_URL.',
            'Set DC_DATABASE_URL (or DATABASE_URL) to your Postgres connection string, or choose DC_DATA=sqlite.')];
    }
    return postgresStore.validate(env);
}

/**
 * Turns a database row into a document.
 *
 * @param {object} row A row of starter_crm_data (`data` is already parsed; times are strings).
 * @returns {object} The document.
 */
function fromRow(row) {
    return toDocument(row, row.data);
}

/**
 * Connects, migrates and returns the provider.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, now?: () => number }} ctx Provider context; `now` is replaced in tests.
 * @returns {Promise<object>} The provider (see the interface in memory.js).
 */
export async function create(ctx) {
    // The driver is only needed when this provider is chosen, so it is not imported at the top of the file.
    const { default: pg } = await import('pg');
    const now = ctx.now || Date.now;
    const site = siteKey(ctx.config);
    const pool = new pg.Pool({ connectionString: postgresStore.databaseUrl(ctx.env), max: 10, connectionTimeoutMillis: 5000 });
    // An idle client dropped by the server must not crash the process; the pool replaces it.
    pool.on('error', () => {});
    await migratePostgres(pool);

    const rows = {
        async insert(collection, owner, fields) {
            const at = now();
            const result = await pool.query(
                'INSERT INTO starter_crm_data (site_id, collection, id, owner_id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *',
                [site, collection, newId(), owner, JSON.stringify(fields), at]);
            return fromRow(result.rows[0]);
        },

        async get(collection, owner, id) {
            const result = await pool.query(
                'SELECT * FROM starter_crm_data WHERE site_id = $1 AND collection = $2 AND id = $3 AND ($4::text IS NULL OR owner_id = $4)',
                [site, collection, id, owner]);
            return result.rows[0] ? fromRow(result.rows[0]) : null;
        },

        async list(collection, owner, where, limit) {
            const params = [site, collection, owner, JSON.stringify(Object.fromEntries(where)), limit];
            const result = await pool.query(
                'SELECT * FROM starter_crm_data WHERE site_id = $1 AND collection = $2 AND ($3::text IS NULL OR owner_id = $3) AND data @> $4::jsonb '
                + 'ORDER BY created_at DESC, id DESC LIMIT $5',
                params);
            return result.rows.map(fromRow);
        },

        async update(collection, owner, id, patch) {
            // `||` merges the top-level keys in one statement, so two writers cannot lose each other's change.
            const result = await pool.query(
                'UPDATE starter_crm_data SET data = data || $1::jsonb, updated_at = GREATEST($2::bigint, created_at) '
                + 'WHERE site_id = $3 AND collection = $4 AND id = $5 AND ($6::text IS NULL OR owner_id = $6) RETURNING *',
                [JSON.stringify(patch), now(), site, collection, id, owner]);
            return result.rows[0] ? fromRow(result.rows[0]) : null;
        },

        async remove(collection, owner, id) {
            const result = await pool.query(
                'DELETE FROM starter_crm_data WHERE site_id = $1 AND collection = $2 AND id = $3 AND ($4::text IS NULL OR owner_id = $4)',
                [site, collection, id, owner]);
            return result.rowCount === 1;
        }
    };

    const views = buildViews(rows);
    return {
        scope: views.scope,
        system: views.system,

        async appliedMigrations() {
            return (await pool.query('SELECT name FROM starter_crm_migrations ORDER BY name')).rows.map((row) => row.name);
        },

        async ready() {
            try {
                await pool.query('SELECT 1');
                return true;
            } catch {
                return false;
            }
        },

        async close() {
            await pool.end();
        }
    };
}
