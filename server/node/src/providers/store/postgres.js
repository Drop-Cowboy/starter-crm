/**
 * The `postgres` event store: events in a Postgres table every instance shares.
 *
 * Where it sits: `DC_STORE=postgres`, with the connection string in
 * `DC_DATABASE_URL` (or the `DATABASE_URL` that Neon and most hosts set, or the
 * `NETLIFY_DB_URL` that Netlify Database sets). This is the store for more than one instance: any number of servers and
 * workers can record, claim and replay against the same table, and a webhook
 * that reaches one instance reaches a browser connected to another.
 *
 * Boot applies the numbered files in server/migrations/postgres under an
 * advisory lock, so instances starting together never migrate at once. Claiming
 * due events uses `FOR UPDATE SKIP LOCKED`, so two workers never take the same
 * event. In production the connection string must ask for TLS (`sslmode=require`
 * or stronger) unless the database is on localhost; the password in the string is
 * redacted from every log line.
 *
 * CONTRACT.md: "Event store".
 * Env: DC_DATABASE_URL, DATABASE_URL or NETLIFY_DB_URL. What a customer changes: nothing.
 */

import { migratePostgres } from '../../migrations.js';
import { problem } from '../../problems.js';
import { allowsPlaintext } from '../../tls.js';
import { DEFAULT_LEASE_MS, REPLAY_OVERLAP_MS, STATUSES, contactIdOf, publicEvent, replayLimit, retentionMs, siteKey } from './common.js';

export const name = 'postgres';
export const configKeys = ['DC_DATABASE_URL', 'DATABASE_URL', 'NETLIFY_DB_URL'];

/**
 * Checks the connection string is present, is a Postgres URL, and asks for TLS in production.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const raw = databaseUrl(env);
    if (!raw) {
        return [problem('missing_database_url', 'DC_STORE=postgres needs DC_DATABASE_URL.',
            'Set DC_DATABASE_URL (or DATABASE_URL) to your Postgres connection string, for example postgres://user:password@host:5432/dbname?sslmode=require.')];
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        return [problem('invalid_database_url', 'DC_DATABASE_URL is not a URL.', 'Use a connection string such as postgres://user:password@host:5432/dbname.')];
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
        return [problem('invalid_database_url', 'DC_DATABASE_URL must start with postgres:// or postgresql://.', 'Use a connection string such as postgres://user:password@host:5432/dbname.')];
    }
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    const tls = ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') || '');
    if (env.DC_ENV === 'production' && !local && !tls && !allowsPlaintext(env)) {
        return [problem('insecure_database_url', 'DC_DATABASE_URL must use TLS in production.',
            'Add ?sslmode=require (or verify-full) to the connection string. Localhost is exempt, and so is a private network you control when DC_INSECURE_PRIVATE_SERVICES=on.')];
    }
    return [];
}

/**
 * Reads the connection string.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {string|null} `DC_DATABASE_URL`, else `DATABASE_URL`, else `NETLIFY_DB_URL`, else null.
 */
export function databaseUrl(env) {
    for (const key of ['DC_DATABASE_URL', 'DATABASE_URL', 'NETLIFY_DB_URL']) {
        if (typeof env[key] === 'string' && env[key].trim() !== '') return env[key].trim();
    }
    return null;
}

/**
 * Turns a database row into an event object.
 *
 * @param {object|undefined} row A row from the events table.
 * @returns {object|null} The event with numeric columns converted (Postgres returns bigint as text), or null for no row.
 */
function fromRow(row) {
    if (!row) return null;
    const number = (value) => (value === null || value === undefined ? null : Number(value));
    return {
        event_id: row.event_id,
        event: row.event,
        event_at: number(row.event_at),
        received_at: number(row.received_at),
        attempt: row.attempt,
        data: row.data,
        contact_id: row.contact_id,
        status: row.status,
        attempts: row.attempts,
        next_attempt_at: number(row.next_attempt_at),
        last_error: row.last_error,
        done_at: number(row.done_at)
    };
}

/**
 * Connects, migrates and returns the store.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, now?: () => number }} ctx Provider context; `now` is replaced in tests.
 * @returns {Promise<object>} The store (see the interface in memory.js).
 */
export async function create(ctx) {
    // The driver is only needed when this store is chosen, so it is not imported at the top of the file.
    const { default: pg } = await import('pg');
    const now = ctx.now || Date.now;
    const site = siteKey(ctx.config);
    const keepMs = retentionMs(ctx.config);
    const pool = new pg.Pool({ connectionString: databaseUrl(ctx.env), max: 10, connectionTimeoutMillis: 5000 });
    // An idle client dropped by the server must not crash the process; the pool replaces it. Queries that
    // fail afterwards report the outage where it can be handled, and /readyz goes red through ready().
    pool.on('error', () => {});
    await migratePostgres(pool);

    return {
        async record(event, { visibleAt } = {}) {
            const inserted = await pool.query(
                'INSERT INTO starter_crm_events (site_id, event_id, event, event_at, received_at, attempt, contact_id, data, status, attempts, next_attempt_at) '
                + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10) ON CONFLICT (site_id, event_id) DO NOTHING',
                [site, event.event_id, event.event, event.event_at, event.received_at, event.attempt, contactIdOf(event.data),
                    JSON.stringify(event.data), STATUSES.received, visibleAt ?? now()]);
            if (inserted.rowCount === 1) return { inserted: true, status: STATUSES.received };
            const existing = await pool.query('SELECT status FROM starter_crm_events WHERE site_id = $1 AND event_id = $2', [site, event.event_id]);
            return { inserted: false, status: existing.rows[0] ? existing.rows[0].status : STATUSES.received };
        },

        async get(eventId) {
            const result = await pool.query('SELECT * FROM starter_crm_events WHERE site_id = $1 AND event_id = $2', [site, eventId]);
            return fromRow(result.rows[0]);
        },

        async markProcessed(eventId) {
            await pool.query('UPDATE starter_crm_events SET status = $1, done_at = $2 WHERE site_id = $3 AND event_id = $4',
                [STATUSES.processed, now(), site, eventId]);
        },

        async markFailed(eventId, error) {
            await pool.query('UPDATE starter_crm_events SET status = $1, done_at = $2, last_error = $3 WHERE site_id = $4 AND event_id = $5',
                [STATUSES.failed, now(), String(error), site, eventId]);
        },

        async noteFailure(eventId, error, nextAttemptAt) {
            const result = await pool.query(
                'UPDATE starter_crm_events SET attempts = attempts + 1, last_error = $1, next_attempt_at = $2 WHERE site_id = $3 AND event_id = $4 RETURNING attempts',
                [String(error), nextAttemptAt, site, eventId]);
            return result.rows[0] ? result.rows[0].attempts : 0;
        },

        async since({ afterEventId, limit } = {}) {
            let from = -1;
            if (afterEventId) {
                const cursor = await pool.query('SELECT done_at FROM starter_crm_events WHERE site_id = $1 AND event_id = $2', [site, afterEventId]);
                const at = cursor.rows[0] ? cursor.rows[0].done_at : null;
                if (at !== null && at !== undefined) from = Number(at) - REPLAY_OVERLAP_MS;
            }
            const result = await pool.query(
                'SELECT * FROM starter_crm_events WHERE site_id = $1 AND done_at IS NOT NULL AND done_at >= $2 AND event_id <> $3 '
                + 'ORDER BY done_at DESC, event_id DESC LIMIT $4',
                [site, from, afterEventId || '', replayLimit(limit)]);
            return result.rows.reverse().map((row) => publicEvent(fromRow(row)));
        },

        async pending({ limit = 10, leaseMs = DEFAULT_LEASE_MS } = {}) {
            const at = now();
            // SKIP LOCKED: a second worker running this at the same moment gets different events, never the same ones.
            const result = await pool.query(
                'UPDATE starter_crm_events SET next_attempt_at = $1 WHERE (site_id, event_id) IN ('
                + "SELECT site_id, event_id FROM starter_crm_events WHERE site_id = $2 AND status = 'received' AND next_attempt_at <= $3 "
                + 'ORDER BY next_attempt_at LIMIT $4 FOR UPDATE SKIP LOCKED) RETURNING *',
                [at + leaseMs, site, at, limit]);
            return result.rows.map(fromRow);
        },

        async listFailed({ limit = 50 } = {}) {
            const result = await pool.query("SELECT * FROM starter_crm_events WHERE site_id = $1 AND status = 'failed' ORDER BY done_at DESC LIMIT $2", [site, limit]);
            return result.rows.map(fromRow);
        },

        async replay(eventId) {
            const result = await pool.query(
                "UPDATE starter_crm_events SET status = 'received', attempts = 0, done_at = NULL, next_attempt_at = $1 WHERE site_id = $2 AND event_id = $3 AND status = 'failed'",
                [now(), site, eventId]);
            return result.rowCount === 1;
        },

        async purgeContact(contactId, keepEventId) {
            const removed = await pool.query('DELETE FROM starter_crm_events WHERE site_id = $1 AND contact_id = $2 AND event_id <> $3', [site, contactId, keepEventId || '']);
            if (keepEventId) {
                await pool.query('UPDATE starter_crm_events SET data = $1 WHERE site_id = $2 AND event_id = $3', [JSON.stringify({ contact_id: contactId }), site, keepEventId]);
            }
            return removed.rowCount;
        },

        async counts() {
            const out = { received: 0, processed: 0, failed: 0, oldest_received_age_seconds: 0 };
            const grouped = await pool.query('SELECT status, COUNT(*)::int AS n FROM starter_crm_events WHERE site_id = $1 GROUP BY status', [site]);
            for (const row of grouped.rows) out[row.status] = row.n;
            const oldest = await pool.query("SELECT MIN(received_at) AS at FROM starter_crm_events WHERE site_id = $1 AND status = 'received'", [site]);
            if (oldest.rows[0] && oldest.rows[0].at !== null) out.oldest_received_age_seconds = Math.round((now() - Number(oldest.rows[0].at)) / 1000);
            return out;
        },

        async prune() {
            const result = await pool.query('DELETE FROM starter_crm_events WHERE site_id = $1 AND done_at IS NOT NULL AND done_at < $2', [site, now() - keepMs]);
            return result.rowCount;
        },

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
