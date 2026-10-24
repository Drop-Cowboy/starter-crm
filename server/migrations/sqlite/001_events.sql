-- The durable event store (DC_STORE=sqlite). Same columns as the Postgres
-- table, with `data` held as JSON text. Both servers (Node and Python) read
-- this same file format. SQLite is single-writer: run one instance.
--
-- status:          received -> processed, or failed after DC_WEBHOOK_MAX_ATTEMPTS.
-- attempts:        handler runs that have failed so far.
-- next_attempt_at: when the outbox may pick a received event up (also the lease
--                  while a worker holds it), in epoch milliseconds.
-- done_at:         when the event finished (processed or failed); the replay
--                  order and the retention clock.
CREATE TABLE starter_crm_events (
    site_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event TEXT,
    event_at INTEGER,
    received_at INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    contact_id TEXT,
    data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    done_at INTEGER,
    PRIMARY KEY (site_id, event_id)
);

CREATE INDEX starter_crm_events_due ON starter_crm_events (site_id, next_attempt_at) WHERE status = 'received';
CREATE INDEX starter_crm_events_done ON starter_crm_events (site_id, done_at) WHERE done_at IS NOT NULL;
CREATE INDEX starter_crm_events_contact ON starter_crm_events (site_id, contact_id) WHERE contact_id IS NOT NULL;
