/**
 * Helpers every event store shares, so the four built-in stores (and yours)
 * agree on the parts of the contract that are easy to get subtly different.
 *
 * Where it sits: memory.js, sqlite.js, postgres.js and redis.js import these.
 * The rules live in one place on purpose: a store that disagrees about the
 * replay window or the status words would pass its own tests and still break
 * a reconnecting browser.
 *
 * CONTRACT.md: "Event store".
 * What a customer changes: nothing; when you write your own store, import these
 * instead of re-deriving them.
 */

/** The statuses an event moves through: `received` until its handlers have run, then `processed` or, after too many failures, `failed`. */
export const STATUSES = Object.freeze({ received: 'received', processed: 'processed', failed: 'failed' });

/**
 * How far back a reconnecting browser's replay reaches before its last event.
 * Instances finish events a moment apart, so a cursor taken from one instance can
 * sit just after an event another instance finished slightly later. Five seconds
 * of overlap catches those; the event stream de-duplicates by id, so the overlap
 * never shows twice.
 */
export const REPLAY_OVERLAP_MS = 5000;

/** The most events a replay returns, whatever the caller asks for. */
export const REPLAY_CAP = 200;

/** How long an in-flight claim on a received event lasts before another worker may take it. */
export const DEFAULT_LEASE_MS = 60000;

/**
 * Picks the contact an event is about, so `contact.deleted` can purge that contact's events.
 *
 * @param {unknown} data The event's `data` object.
 * @returns {string|null} `data.contact_id` when it is a non-empty string, else null.
 */
export function contactIdOf(data) {
    if (data && typeof data === 'object' && typeof data.contact_id === 'string' && data.contact_id !== '') {
        return data.contact_id;
    }
    return null;
}

/**
 * Trims a stored row down to the event the browser receives. The status,
 * attempt counters and error text are the server's business, not the page's.
 *
 * @param {object} row An event as a store holds it.
 * @returns {{ event_id: string, event: string|null, event_at: number|null, received_at: number, attempt: number, data: object }}
 *   The wire shape of an event, unchanged since Phase 1.
 */
export function publicEvent(row) {
    return {
        event_id: row.event_id,
        event: row.event,
        event_at: row.event_at,
        received_at: row.received_at,
        attempt: row.attempt,
        data: row.data
    };
}

/**
 * Clamps a replay limit.
 *
 * @param {number|undefined} limit What the caller asked for.
 * @returns {number} A whole number from 1 to REPLAY_CAP; REPLAY_CAP when unset.
 */
export function replayLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1) return REPLAY_CAP;
    return Math.min(limit, REPLAY_CAP);
}

/**
 * The retention window in milliseconds.
 *
 * @param {{ events?: { retentionHours?: number } }} config The loaded config.
 * @returns {number} Milliseconds events are kept after they finish.
 */
export function retentionMs(config) {
    const hours = config.events && Number.isFinite(config.events.retentionHours) ? config.events.retentionHours : 72;
    return hours * 3600 * 1000;
}

/**
 * The name events are filed under, so two apps sharing one store never see each
 * other's events. It is the app's `DROPCOWBOY_SITE_ID`; modes that do not need one
 * share the name `default`.
 *
 * @param {{ siteId?: string|null }} config The loaded config.
 * @returns {string} The site key.
 */
export function siteKey(config) {
    return config.siteId || 'default';
}

/** The methods a custom `DC_STORE` provider's instance must have; boot checks for them. */
export const STORE_METHODS = Object.freeze([
    'record', 'get', 'markProcessed', 'markFailed', 'noteFailure', 'since', 'pending',
    'listFailed', 'replay', 'purgeContact', 'counts', 'prune', 'ready', 'close'
]);
