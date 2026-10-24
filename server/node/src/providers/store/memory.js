/**
 * The `memory` event store: events live in this process and vanish on restart.
 *
 * Where it sits: `DC_STORE=memory`, the default. It is what you want while
 * you build: nothing to install, and every other piece (the outbox, the event
 * stream, replay) behaves exactly as it will on a durable store. It cannot be
 * shared between instances, so boot refuses to pair it with a shared fan-out
 * or a Redis queue.
 *
 * The store interface (every store, built-in or yours, implements it):
 * - `record(event, { visibleAt })` -> `{ inserted, status }`: atomic
 *   insert-if-absent by `event_id`. `visibleAt` is when the outbox may first
 *   pick the event up (default: now).
 * - `get(eventId)` -> the event with `status`, `attempts`, `last_error`, `done_at`, or null.
 * - `markProcessed(eventId)` and `markFailed(eventId, error)` finish an event.
 * - `noteFailure(eventId, error, nextAttemptAt)` -> attempts so far, after counting one failure.
 * - `since({ afterEventId, limit })` -> finished events, oldest first (section "Replay" in CONTRACT.md).
 * - `pending({ limit, leaseMs })` -> received events due now, claimed for `leaseMs`.
 * - `listFailed({ limit })`, `replay(eventId)`, `purgeContact(contactId, keepEventId)`,
 *   `counts()`, `prune()`, `ready()` and `close()`.
 * All of them return promises, so a store backed by a network service fits the same shape.
 *
 * CONTRACT.md: "Event store".
 * What a customer changes: nothing; to keep events across restarts set `DC_STORE`.
 */

import { DEFAULT_LEASE_MS, REPLAY_OVERLAP_MS, STATUSES, contactIdOf, publicEvent, replayLimit, retentionMs } from './common.js';

export const name = 'memory';
export const configKeys = [];

/** Finished events kept beyond this many are dropped oldest first, so a long-running dev server cannot grow without bound. */
const MAX_FINISHED = 5000;

/**
 * Nothing to configure.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the store.
 *
 * @param {{ config: object, now?: () => number }} ctx Provider context; `now` is replaced in tests.
 * @returns {object} The store (see the interface in this file's header).
 */
export function create(ctx) {
    const now = ctx.now || Date.now;
    const keepMs = retentionMs(ctx.config);
    // Every stored event by id.
    const rows = new Map();

    /**
     * Copies a row so callers cannot change what the store holds.
     *
     * @param {object} row A stored row.
     * @returns {object} A deep copy.
     */
    function copy(row) {
        return structuredClone(row);
    }

    /**
     * The finished rows, oldest first.
     *
     * @returns {object[]} Rows with a `done_at`, ordered by `done_at` then `event_id`.
     */
    function finished() {
        return [...rows.values()]
            .filter((row) => row.done_at !== null)
            .sort((a, b) => a.done_at - b.done_at || (a.event_id < b.event_id ? -1 : 1));
    }

    /**
     * Marks a row finished.
     *
     * @param {string} eventId The event.
     * @param {string} status `processed` or `failed`.
     * @param {string|null} error The last error, for `failed`.
     * @returns {Promise<void>}
     */
    async function finish(eventId, status, error) {
        const row = rows.get(eventId);
        if (!row) return;
        row.status = status;
        row.done_at = now();
        if (error !== null) row.last_error = error;
        const done = finished();
        for (let i = 0; i < done.length - MAX_FINISHED; i++) rows.delete(done[i].event_id);
    }

    return {
        async record(event, { visibleAt } = {}) {
            const existing = rows.get(event.event_id);
            if (existing) return { inserted: false, status: existing.status };
            rows.set(event.event_id, {
                event_id: event.event_id,
                event: event.event,
                event_at: event.event_at,
                received_at: event.received_at,
                attempt: event.attempt,
                data: structuredClone(event.data),
                contact_id: contactIdOf(event.data),
                status: STATUSES.received,
                attempts: 0,
                next_attempt_at: visibleAt ?? now(),
                last_error: null,
                done_at: null
            });
            return { inserted: true, status: STATUSES.received };
        },

        async get(eventId) {
            const row = rows.get(eventId);
            return row ? copy(row) : null;
        },

        markProcessed(eventId) {
            return finish(eventId, STATUSES.processed, null);
        },

        markFailed(eventId, error) {
            return finish(eventId, STATUSES.failed, String(error));
        },

        async noteFailure(eventId, error, nextAttemptAt) {
            const row = rows.get(eventId);
            if (!row) return 0;
            row.attempts++;
            row.last_error = String(error);
            row.next_attempt_at = nextAttemptAt;
            return row.attempts;
        },

        async since({ afterEventId, limit } = {}) {
            const done = finished();
            const cursor = afterEventId ? rows.get(afterEventId) : null;
            const from = cursor && cursor.done_at !== null ? cursor.done_at - REPLAY_OVERLAP_MS : -Infinity;
            const window = done.filter((row) => row.done_at >= from && row.event_id !== afterEventId);
            return window.slice(-replayLimit(limit)).map(publicEvent);
        },

        async pending({ limit = 10, leaseMs = DEFAULT_LEASE_MS } = {}) {
            const at = now();
            const due = [...rows.values()]
                .filter((row) => row.status === STATUSES.received && row.next_attempt_at <= at)
                .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
                .slice(0, limit);
            for (const row of due) row.next_attempt_at = at + leaseMs;
            return due.map(copy);
        },

        async listFailed({ limit = 50 } = {}) {
            return [...rows.values()]
                .filter((row) => row.status === STATUSES.failed)
                .sort((a, b) => b.done_at - a.done_at)
                .slice(0, limit)
                .map(copy);
        },

        async replay(eventId) {
            const row = rows.get(eventId);
            if (!row || row.status !== STATUSES.failed) return false;
            row.status = STATUSES.received;
            row.attempts = 0;
            row.done_at = null;
            row.next_attempt_at = now();
            return true;
        },

        async purgeContact(contactId, keepEventId) {
            let removed = 0;
            for (const row of [...rows.values()]) {
                if (row.contact_id !== contactId) continue;
                if (row.event_id === keepEventId) {
                    row.data = { contact_id: contactId };
                    continue;
                }
                rows.delete(row.event_id);
                removed++;
            }
            return removed;
        },

        async counts() {
            const at = now();
            const out = { received: 0, processed: 0, failed: 0, oldest_received_age_seconds: 0 };
            for (const row of rows.values()) {
                out[row.status]++;
                if (row.status === STATUSES.received) {
                    out.oldest_received_age_seconds = Math.max(out.oldest_received_age_seconds, Math.round((at - row.received_at) / 1000));
                }
            }
            return out;
        },

        async prune() {
            const cutoff = now() - keepMs;
            let removed = 0;
            for (const row of [...rows.values()]) {
                if (row.done_at !== null && row.done_at < cutoff) {
                    rows.delete(row.event_id);
                    removed++;
                }
            }
            return removed;
        },

        async ready() {
            return true;
        },

        async close() {}
    };
}
