// The Postgres migration lock: it must end with the migration, even when the connection string is a pooler that
// hands each statement outside a transaction to a different server connection.
import { describe, expect, it } from 'vitest';
import { migratePostgres } from '../src/migrations.js';
import { HAVE_POSTGRES, POSTGRES_URL } from './services.js';

const LOCK_KEY = 727001;

/** @returns {Promise<{ pg: object, pool: object }>} A pool on the test database. */
async function open() {
    const { default: pg } = await import('pg');
    return { pg, pool: new pg.Pool({ connectionString: POSTGRES_URL, max: 6 }) };
}

describe.skipIf(!HAVE_POSTGRES)('migratePostgres (needs the Postgres from tests/services.compose.yml)', () => {
    it('leaves no advisory lock behind, however many instances start at once', async () => {
        const { pool } = await open();
        try {
            await Promise.all([1, 2, 3, 4, 5].map(() => migratePostgres(pool)));
            // A transaction-scoped lock ends with its transaction, so none may be held by a session that is idle. Other
            // test files run migrations at the same moment, so a lock held by a busy session is theirs.
            const held = await pool.query(
                "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid "
                + "WHERE l.locktype = 'advisory' AND l.objid = $1 AND a.state = 'idle'", [LOCK_KEY]);
            expect(held.rows[0].n).toBe(0);
        } finally {
            await pool.end();
        }
    });

    it('waits for an instance that is migrating, then carries on', async () => {
        const { pool } = await open();
        const holder = await pool.connect();
        try {
            await holder.query('BEGIN');
            await holder.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
            let finished = false;
            const waiting = migratePostgres(pool).then((applied) => { finished = true; return applied; });
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(finished).toBe(false);
            await holder.query('COMMIT');
            expect(await waiting).toEqual([]);
        } finally {
            holder.release();
            await pool.end();
        }
    });
});
