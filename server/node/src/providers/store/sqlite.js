/**
 * The `sqlite` event store: one file on disk, no server to run.
 *
 * Where it sits: `DC_STORE=sqlite`, with the file at `DC_SQLITE_PATH` (default
 * `data/starter-crm.sqlite` under the starter root). Events survive a restart,
 * which makes this the simplest durable store for a single instance on a VPS or
 * a Compose host. It uses Node's built-in `node:sqlite`, so there is nothing to
 * install, with the write-ahead log on so reads never block the writer.
 *
 * SQLite allows one writer at a time and cannot be shared across machines, so
 * run one instance. A second process on the same file works (the busy timeout
 * makes it wait its turn), which is how the multi-instance tests exercise it,
 * but it is not a way to scale out; use `postgres` for that.
 *
 * The table is created by the numbered files in server/migrations/sqlite, shared
 * with the Python server, so either server can open the other's file.
 *
 * CONTRACT.md: "Event store".
 * Env: DC_SQLITE_PATH. What a customer changes: nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { migrateSqlite } from '../../migrations.js';
import { DEFAULT_LEASE_MS, REPLAY_OVERLAP_MS, STATUSES, contactIdOf, publicEvent, replayLimit, retentionMs, siteKey } from './common.js';

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
 * Turns a database row into an event object.
 *
 * @param {object|undefined} row A row from the events table.
 * @returns {object|null} The event, with its JSON `data` parsed, or null for no row.
 */
function fromRow(row) {
    if (!row) return null;
    return {
        event_id: row.event_id,
        event: row.event,
        event_at: row.event_at,
        received_at: row.received_at,
        attempt: row.attempt,
        data: JSON.parse(row.data),
        contact_id: row.contact_id,
        status: row.status,
        attempts: row.attempts,
        next_attempt_at: row.next_attempt_at,
        last_error: row.last_error,
        done_at: row.done_at
    };
}

/**
 * Opens the database, creates its folder and applies migrations.
 *
 * @param {{ config: object, now?: () => number }} ctx Provider context; `now` is replaced in tests.
 * @returns {Promise<object>} The store (see the interface in memory.js).
 */
export async function create(ctx) {
    // The built-in module is only needed when this store is chosen, so it is not imported at the top of the file.
    const { DatabaseSync } = await import('node:sqlite');
    const now = ctx.now || Date.now;
    const site = siteKey(ctx.config);
    const keepMs = retentionMs(ctx.config);
    const file = path.resolve(ctx.config.root, ctx.config.events.sqlitePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    migrateSqlite(db);

    const sql = {
        insert: db.prepare('INSERT INTO starter_crm_events (site_id, event_id, event, event_at, received_at, attempt, contact_id, data, status, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (site_id, event_id) DO NOTHING'),
        get: db.prepare('SELECT * FROM starter_crm_events WHERE site_id = ? AND event_id = ?'),
        finish: db.prepare('UPDATE starter_crm_events SET status = ?, done_at = ?, last_error = COALESCE(?, last_error) WHERE site_id = ? AND event_id = ?'),
        note: db.prepare('UPDATE starter_crm_events SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE site_id = ? AND event_id = ?'),
        window: db.prepare("SELECT * FROM starter_crm_events WHERE site_id = ? AND done_at IS NOT NULL AND done_at >= ? AND event_id <> ? ORDER BY done_at DESC, event_id DESC LIMIT ?"),
        due: db.prepare("SELECT * FROM starter_crm_events WHERE site_id = ? AND status = 'received' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?"),
        lease: db.prepare('UPDATE starter_crm_events SET next_attempt_at = ? WHERE site_id = ? AND event_id = ?'),
        failed: db.prepare("SELECT * FROM starter_crm_events WHERE site_id = ? AND status = 'failed' ORDER BY done_at DESC LIMIT ?"),
        replay: db.prepare("UPDATE starter_crm_events SET status = 'received', attempts = 0, done_at = NULL, next_attempt_at = ? WHERE site_id = ? AND event_id = ? AND status = 'failed'"),
        purge: db.prepare('DELETE FROM starter_crm_events WHERE site_id = ? AND contact_id = ? AND event_id <> ?'),
        scrub: db.prepare('UPDATE starter_crm_events SET data = ? WHERE site_id = ? AND event_id = ?'),
        counts: db.prepare('SELECT status, COUNT(*) AS n FROM starter_crm_events WHERE site_id = ? GROUP BY status'),
        oldest: db.prepare("SELECT MIN(received_at) AS at FROM starter_crm_events WHERE site_id = ? AND status = 'received'"),
        prune: db.prepare('DELETE FROM starter_crm_events WHERE site_id = ? AND done_at IS NOT NULL AND done_at < ?')
    };

    /**
     * Reads one finished-state cursor.
     *
     * @param {string|undefined} eventId The cursor event.
     * @returns {number|null} Its `done_at`, or null when it is unknown or not finished.
     */
    function cursorTime(eventId) {
        if (!eventId) return null;
        const row = sql.get.get(site, eventId);
        return row && row.done_at !== null ? row.done_at : null;
    }

    return {
        async record(event, { visibleAt } = {}) {
            const result = sql.insert.run(site, event.event_id, event.event, event.event_at, event.received_at, event.attempt,
                contactIdOf(event.data), JSON.stringify(event.data), STATUSES.received, visibleAt ?? now());
            if (result.changes === 1) return { inserted: true, status: STATUSES.received };
            return { inserted: false, status: sql.get.get(site, event.event_id).status };
        },

        async get(eventId) {
            return fromRow(sql.get.get(site, eventId));
        },

        async markProcessed(eventId) {
            sql.finish.run(STATUSES.processed, now(), null, site, eventId);
        },

        async markFailed(eventId, error) {
            sql.finish.run(STATUSES.failed, now(), String(error), site, eventId);
        },

        async noteFailure(eventId, error, nextAttemptAt) {
            sql.note.run(String(error), nextAttemptAt, site, eventId);
            const row = sql.get.get(site, eventId);
            return row ? row.attempts : 0;
        },

        async since({ afterEventId, limit } = {}) {
            const at = cursorTime(afterEventId);
            const from = at === null ? -1 : at - REPLAY_OVERLAP_MS;
            const rows = sql.window.all(site, from, afterEventId || '', replayLimit(limit));
            return rows.reverse().map((row) => publicEvent(fromRow(row)));
        },

        async pending({ limit = 10, leaseMs = DEFAULT_LEASE_MS } = {}) {
            // One writer at a time, so selecting then leasing inside a transaction cannot hand an event to two workers.
            db.exec('BEGIN IMMEDIATE');
            try {
                const at = now();
                const rows = sql.due.all(site, at, limit);
                for (const row of rows) sql.lease.run(at + leaseMs, site, row.event_id);
                db.exec('COMMIT');
                return rows.map(fromRow);
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
        },

        async listFailed({ limit = 50 } = {}) {
            return sql.failed.all(site, limit).map(fromRow);
        },

        async replay(eventId) {
            return sql.replay.run(now(), site, eventId).changes === 1;
        },

        async purgeContact(contactId, keepEventId) {
            const removed = sql.purge.run(site, contactId, keepEventId || '').changes;
            if (keepEventId) sql.scrub.run(JSON.stringify({ contact_id: contactId }), site, keepEventId);
            return Number(removed);
        },

        async counts() {
            const out = { received: 0, processed: 0, failed: 0, oldest_received_age_seconds: 0 };
            for (const row of sql.counts.all(site)) out[row.status] = Number(row.n);
            const oldest = sql.oldest.get(site);
            if (oldest && oldest.at !== null) out.oldest_received_age_seconds = Math.round((now() - oldest.at) / 1000);
            return out;
        },

        async prune() {
            return Number(sql.prune.run(site, now() - keepMs).changes);
        },

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
