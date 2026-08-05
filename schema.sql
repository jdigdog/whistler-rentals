-- Starter schema for whistler-rentals.
-- This exists to make the example queries in src/index.ts run; replace it
-- with your real data model. Once you have real data, switch to
-- `wrangler d1 migrations` instead of re-running this file.

DROP TABLE IF EXISTS listings;
DROP TABLE IF EXISTS landlords;

CREATE TABLE landlords (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT UNIQUE,
  verified      INTEGER NOT NULL DEFAULT 0,
  verified_at   TEXT,
  fb_user_id    TEXT,               -- for the Facebook group migration
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE listings (
  id             TEXT PRIMARY KEY,
  landlord_id    TEXT NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  neighbourhood  TEXT,              -- Creekside, Function, Pemberton, etc.
  rent_cents     INTEGER NOT NULL,  -- store money as integer cents
  bedrooms       REAL,
  furnished      INTEGER NOT NULL DEFAULT 0,
  available_from TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('draft','active','rented','expired')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_listings_active  ON listings(status, created_at DESC);
CREATE INDEX idx_listings_hood    ON listings(neighbourhood, status);
CREATE INDEX idx_listings_rent    ON listings(rent_cents);
CREATE INDEX idx_landlords_verified ON landlords(verified);
