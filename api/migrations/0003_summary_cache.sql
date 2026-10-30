-- A single row holding the computed /summary payload.
--
-- Why this exists: D1 bills rows READ, and the free tier allows 5,000,000 a
-- day. Recomputing /summary from the checks table costs tens of thousands of
-- rows, so the only safe design is to compute it rarely and serve it cheaply.
-- The Cache API in front of the Worker is per-colo, so it cannot bound that: N
-- colos means up to N recomputations per cache period. This table is the
-- global backstop -- one row, one read, shared by every colo.
--
-- Keyed on the collection slot rather than on a wall-clock TTL. The collector
-- writes one batch per slot, so the data physically cannot change inside a
-- slot; recomputing more often than that spends quota to produce an identical
-- answer. Keyed on `version` as well, so a deployment that changes the shape
-- or meaning of the response cannot serve a stale payload computed under the
-- old rules -- the row simply misses and is recomputed.
--
-- `id` is pinned to 1 by a CHECK, so this table holds exactly one row and a
-- read of it is a primary-key lookup costing one row.
CREATE TABLE IF NOT EXISTS summary_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),

  -- Response-shape version. Must match the Worker's SUMMARY_CACHE_VERSION.
  version     TEXT    NOT NULL,

  -- The slot this payload was computed in. A request in a later slot misses.
  slot_start  INTEGER NOT NULL,

  -- The JSON body served verbatim to the client.
  payload     TEXT    NOT NULL,

  computed_at INTEGER NOT NULL
);

-- No index. The table has one row and `id` is the primary key; an index here
-- would be the cargo cult the schema comment in 0001 warns about.
