/**
 * The `postgres` fan-out: `LISTEN` and `NOTIFY` carry each finished event's id between instances.
 *
 * Where it sits: `DC_FANOUT=postgres`, the default for the postgres store when
 * there is no Redis. Publishing runs `pg_notify` with the event id; every
 * instance holds one `LISTEN` connection and reads the event from the store before
 * handing it to its streams, so contact data never travels in a notification.
 *
 * It needs a direct connection, not a pooled one: a transaction-mode pooler
 * (PgBouncer, pooled Neon and Netlify Database URLs) never delivers
 * notifications. On those, use `poll`. If the listening connection drops, it
 * reconnects on its own, and browsers catch up by replaying from the store.
 *
 * CONTRACT.md: "Fan-out".
 * Env: DC_DATABASE_URL (the same database as the store). What a customer changes: nothing.
 */

import crypto from 'node:crypto';
import { databaseUrl } from '../store/postgres.js';
import { siteKey } from '../store/common.js';
import { problem } from '../../problems.js';
import { publicEvent } from '../store/common.js';
import { createHub } from './hub.js';

export const name = 'postgres';
export const configKeys = ['DC_DATABASE_URL', 'DATABASE_URL', 'NETLIFY_DB_URL'];

/** How long to wait before reconnecting a dropped listener. */
const RECONNECT_MS = 1000;

/**
 * Checks the connection string is there (the store's own validation checks its shape).
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    if (!databaseUrl(env)) {
        return [problem('missing_database_url', 'DC_FANOUT=postgres needs DC_DATABASE_URL.', 'Set DC_DATABASE_URL, or choose DC_FANOUT=poll.')];
    }
    return [];
}

/**
 * The notification channel for one site: a Postgres identifier of at most 63 characters.
 *
 * @param {{ siteId?: string|null }} config The loaded config.
 * @returns {string} For example `starter_crm_3f8a2c1e9b4d7a6c`.
 */
export function channelName(config) {
    return 'starter_crm_' + crypto.createHash('sha1').update(siteKey(config)).digest('hex').slice(0, 16);
}

/**
 * Starts listening and returns the fan-out.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, store: object }} ctx Provider context; `store` is where events are read.
 * @returns {Promise<object>} The fan-out instance.
 */
export async function create(ctx) {
    const { default: pg } = await import('pg');
    const channel = channelName(ctx.config);
    const url = databaseUrl(ctx.env);
    const hub = createHub();
    const publisher = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000 });
    publisher.on('error', () => {});
    let listener = null;
    let closed = false;
    let timer = null;

    /**
     * Opens the listening connection, and schedules a reconnect when it drops.
     *
     * @returns {Promise<void>}
     */
    async function listen() {
        const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
        // Notifications arrive outside any request, so the handler cannot await: it reads the event and delivers it.
        client.on('notification', (message) => {
            ctx.store.get(message.payload).then((row) => {
                if (row) hub.deliver(publicEvent(row));
            }, () => {});
        });
        const lost = () => {
            if (closed || listener !== client) return;
            listener = null;
            timer = setTimeout(() => {
                timer = null;
                listen().catch(lost);
            }, RECONNECT_MS);
            timer.unref?.();
        };
        client.on('error', lost);
        client.on('end', lost);
        await client.connect();
        await client.query('LISTEN ' + channel);
        listener = client;
    }
    await listen();

    return {
        async publish(event) {
            await publisher.query('SELECT pg_notify($1, $2)', [channel, event.event_id]);
        },
        subscribe: hub.subscribe,
        async ready() {
            return listener !== null;
        },
        async close() {
            closed = true;
            if (timer) clearTimeout(timer);
            if (listener) await listener.end();
            await publisher.end();
        }
    };
}
