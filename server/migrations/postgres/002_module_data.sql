-- Module data (DC_DATA=postgres): one table for every collection every module
-- uses, so adding a module never needs a migration. A document is the jsonb in
-- `data`; the columns beside it are the ones the data API itself enforces.
-- Both servers (Node and Python) read this same table.
--
-- site_id:    which app the row belongs to (DROPCOWBOY_SITE_ID), so two apps on
--             one database never see each other's rows.
-- collection: the module's name for the kind of thing, such as `deals`.
-- owner_id:   who the document belongs to. The data API filters on it for
--             every signed-in request; module code cannot forget to.
-- created_at, updated_at: epoch milliseconds; documents list newest first.
CREATE TABLE starter_crm_data (
    site_id text NOT NULL,
    collection text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    data jsonb NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (site_id, collection, id)
);

CREATE INDEX starter_crm_data_owner ON starter_crm_data (site_id, collection, owner_id, created_at DESC);
