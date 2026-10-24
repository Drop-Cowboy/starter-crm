-- The durable event store (DC_STORE=postgres). One row per webhook event,
-- scoped by site_id so two apps can share a database without seeing each
-- other's events. Both servers (Node and Python) read this same table.
--
-- status:          received -> processed, or failed after DC_WEBHOOK_MAX_ATTEMPTS.
-- attempts:        handler runs that have failed so far.
-- next_attempt_at: when the outbox may pick a received event up (also the lease
--                  while a worker holds it), in epoch milliseconds.
-- done_at:         when the event finished (processed or failed); the replay
--                  order and the retention clock.
CREATE TABLE starter_crm_events (
    site_id text NOT NULL,
    event_id text NOT NULL,
    event text,
    event_at bigint,
    received_at bigint NOT NULL,
    attempt integer NOT NULL DEFAULT 1,
    contact_id text,
    data jsonb NOT NULL,
    status text NOT NULL DEFAULT 'received',
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL,
    last_error text,
    done_at bigint,
    PRIMARY KEY (site_id, event_id)
);

CREATE INDEX starter_crm_events_due ON starter_crm_events (site_id, next_attempt_at) WHERE status = 'received';
CREATE INDEX starter_crm_events_done ON starter_crm_events (site_id, done_at) WHERE done_at IS NOT NULL;
CREATE INDEX starter_crm_events_contact ON starter_crm_events (site_id, contact_id) WHERE contact_id IS NOT NULL;
