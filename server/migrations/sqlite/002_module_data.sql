-- Module data (DC_DATA=sqlite): one table for every collection every module
-- uses, so adding a module never needs a migration. A document is the JSON in
-- `data`; the columns beside it are the ones the data API itself enforces.
--
-- site_id:    which app the row belongs to (DROPCOWBOY_SITE_ID), so two apps on
--             one database never see each other's rows.
-- collection: the module's name for the kind of thing, such as `deals`.
-- owner_id:   who the document belongs to. The data API filters on it for
--             every signed-in request; module code cannot forget to.
-- created_at, updated_at: epoch milliseconds; documents list newest first.
CREATE TABLE starter_crm_data (
    site_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (site_id, collection, id)
);

CREATE INDEX starter_crm_data_owner ON starter_crm_data (site_id, collection, owner_id, created_at DESC);
