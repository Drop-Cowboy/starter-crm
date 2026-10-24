/**
 * Numbered SQL migrations for the SQL-backed stores.
 *
 * Where it sits: the sqlite and postgres stores call `migrateSqlite()` or
 * `migratePostgres()` once at boot, before they serve anything. The files live
 * in `server/migrations/<kind>/NNN_name.sql`, shared with the Python server, so
 * both servers upgrade the same database the same way. They are found next to this
 * code, not under `STARTER_CRM_ROOT`, because they are part of the server. `npm run migrate:status`
 * (src/cli.js) lists what has run.
 *
 * Two instances starting together must not both migrate. Postgres uses a
 * transaction-scoped advisory lock, so the second instance waits, finds nothing to do and
 * carries on. SQLite takes `BEGIN IMMEDIATE`, and SQLite is single-writer anyway.
 *
 * CONTRACT.md: "Event store" (Migrations).
 * What a customer changes: add a new numbered file; never edit one that has shipped.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the migration files live: `server/migrations`, two folders above this file's `server/node/src`. */
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..', 'migrations');

/** The advisory-lock key for Postgres migrations: any constant, so every instance contends for the same lock. */
const LOCK_KEY = 727001;

/** How long a boot waits for another instance's migration before giving up. */
const LOCK_TIMEOUT_SECONDS = 60;

/** The table that records which migrations have run. */
const TABLE = 'starter_crm_migrations';

/**
 * Reads the migration files for one database kind, in order.
 *
 * @param {'sqlite'|'postgres'} kind Which folder to read.
 * @returns {{ name: string, sql: string }[]} The files, sorted by name (the number prefix orders them).
 * @throws {Error} When the folder is missing, which means the image or checkout is incomplete.
 */
export function readMigrations(kind) {
    const dir = path.join(MIGRATIONS_DIR, kind);
    const names = fs.readdirSync(dir).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
    return names.map((file) => ({ name: file.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

/**
 * Applies every pending migration to a SQLite database.
 *
 * @param {import('node:sqlite').DatabaseSync} db An open database.
 * @returns {string[]} The names of the migrations this call applied.
 * @throws {Error} The failing migration's error, after the whole batch is rolled back.
 */
export function migrateSqlite(db) {
    db.exec('CREATE TABLE IF NOT EXISTS ' + TABLE + ' (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const applied = [];
    db.exec('BEGIN IMMEDIATE');
    try {
        const done = new Set(db.prepare('SELECT name FROM ' + TABLE).all().map((row) => row.name));
        for (const migration of readMigrations('sqlite')) {
            if (done.has(migration.name)) continue;
            db.exec(migration.sql);
            db.prepare('INSERT INTO ' + TABLE + ' (name, applied_at) VALUES (?, ?)').run(migration.name, Date.now());
            applied.push(migration.name);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    return applied;
}

/**
 * Applies every pending migration to a Postgres database, under an advisory lock.
 *
 * The lock is taken inside one transaction (`pg_advisory_xact_lock`), not for the session. A pooled connection
 * string (PgBouncer in transaction mode, which Neon and Supabase hand out by default) gives each statement outside a
 * transaction whichever server connection is free, so a session lock is taken on one and "released" on another and
 * stays held until that server connection is recycled: every later boot then waits for it forever. A lock that ends
 * with the transaction cannot leak that way. The wait is also capped, so a stuck holder fails the boot with a
 * message instead of hanging every request.
 *
 * @param {import('pg').Pool} pool A connected pool.
 * @returns {Promise<string[]>} The names of the migrations this call applied.
 */
export async function migratePostgres(pool) {
    const client = await pool.connect();
    const applied = [];
    try {
        await client.query('BEGIN');
        try {
            await client.query("SET LOCAL lock_timeout = '" + LOCK_TIMEOUT_SECONDS + "s'");
            await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
            await client.query('CREATE TABLE IF NOT EXISTS ' + TABLE + ' (name text PRIMARY KEY, applied_at bigint NOT NULL)');
            const done = new Set((await client.query('SELECT name FROM ' + TABLE)).rows.map((row) => row.name));
            for (const migration of readMigrations('postgres')) {
                if (done.has(migration.name)) continue;
                await client.query(migration.sql);
                await client.query('INSERT INTO ' + TABLE + ' (name, applied_at) VALUES ($1, $2)', [migration.name, Date.now()]);
                applied.push(migration.name);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
    } finally {
        client.release();
    }
    return applied;
}

/**
 * Lists which migrations have run and which are waiting.
 *
 * @param {string[]} appliedNames The names recorded in the database (empty if the table does not exist yet).
 * @param {'sqlite'|'postgres'} kind Which folder to compare against.
 * @returns {{ applied: string[], pending: string[] }} The two lists, in order.
 */
export function migrationStatus(appliedNames, kind) {
    const done = new Set(appliedNames);
    const all = readMigrations(kind).map((migration) => migration.name);
    return { applied: all.filter((name) => done.has(name)), pending: all.filter((name) => !done.has(name)) };
}
