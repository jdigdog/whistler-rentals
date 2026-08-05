-- 0001_init.sql — core schema for the Whistler verified-rentals platform
-- Target: Cloudflare D1 (SQLite). Run with: npx wrangler d1 migrations apply rentals

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  phone             TEXT,
  phone_verified_at TEXT,
  display_name      TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('tenant', 'landlord', 'admin')),
  -- 0 = unverified, 1 = contact verified, 2 = ID verified, 3 = property control proven
  verification_tier INTEGER NOT NULL DEFAULT 0 CHECK (verification_tier BETWEEN 0 AND 3),
  suspended_at      TEXT,
  source            TEXT,               -- 'facebook_group', 'direct', 'referral'
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_role_tier ON users (role, verification_tier);

-- Append-only audit trail. Never store the ID document itself — only the
-- provider reference. Tier on users is derived from the rows here.
CREATE TABLE verifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'government_id', 'property_control')),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'failed', 'expired')),
  provider      TEXT,                   -- 'stripe_identity', 'manual_review', 'otp'
  provider_ref  TEXT,                   -- e.g. Stripe VerificationSession id
  evidence_key  TEXT,                   -- R2 key in the PRIVATE bucket, if any
  reviewer_id   TEXT REFERENCES users(id),
  reviewer_note TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT
);

CREATE INDEX idx_verifications_user ON verifications (user_id, kind, status);
CREATE INDEX idx_verifications_queue ON verifications (status, created_at);

-- ---------------------------------------------------------------------------
-- Supply
-- ---------------------------------------------------------------------------

CREATE TABLE properties (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_line      TEXT NOT NULL,      -- never exposed publicly until a match
  unit              TEXT,
  neighbourhood     TEXT NOT NULL,      -- 'Creekside', 'Alpine', 'Pemberton', ...
  approx_lat        REAL,               -- jittered for the public map
  approx_lng        REAL,
  -- The legal-tenancy declaration. This is the trust differentiator.
  zoning_class      TEXT NOT NULL CHECK (zoning_class IN ('residential_long_term', 'phase_1', 'phase_2', 'employee_housing', 'unknown')),
  nightly_permitted INTEGER NOT NULL DEFAULT 0 CHECK (nightly_permitted IN (0, 1)),
  control_proven_at TEXT,               -- set when a property_control verification passes
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_properties_owner ON properties (owner_id);

CREATE TABLE listings (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  term_type      TEXT NOT NULL CHECK (term_type IN ('winter_seasonal', 'summer_seasonal', 'annual', 'month_to_month')),
  rent_cents     INTEGER NOT NULL CHECK (rent_cents > 0),
  rent_period    TEXT NOT NULL DEFAULT 'month' CHECK (rent_period IN ('month', 'season')),
  utilities_incl INTEGER NOT NULL DEFAULT 0,
  bedrooms       REAL NOT NULL,
  bathrooms      REAL NOT NULL,
  max_occupancy  INTEGER,
  furnished      INTEGER NOT NULL DEFAULT 0,
  pets_allowed   INTEGER NOT NULL DEFAULT 0,
  parking_spots  INTEGER NOT NULL DEFAULT 0,
  transit_note   TEXT,                  -- 'On the free shuttle route', 'Valley Trail 2 min'
  available_from TEXT NOT NULL,
  available_to   TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'live', 'paused', 'filled', 'removed')),
  -- Exclusivity window: the site sees it now, the Facebook group sees it later.
  publish_at     TEXT,
  fb_release_at  TEXT,
  filled_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_listings_search ON listings (status, term_type, available_from, rent_cents);
CREATE INDEX idx_listings_owner ON listings (owner_id, status);
CREATE INDEX idx_listings_fb_queue ON listings (status, fb_release_at);

CREATE TABLE listing_photos (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,             -- key in the PUBLIC media bucket
  phash      TEXT,                      -- perceptual hash, for duplicate/scam detection
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_photos_listing ON listing_photos (listing_id, sort_order);
CREATE INDEX idx_photos_phash ON listing_photos (phash);

-- ---------------------------------------------------------------------------
-- Demand
-- ---------------------------------------------------------------------------

CREATE TABLE saved_searches (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  filters_json     TEXT NOT NULL,       -- serialized filter object
  frequency        TEXT NOT NULL DEFAULT 'instant' CHECK (frequency IN ('instant', 'daily', 'off')),
  last_notified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_saved_searches_active ON saved_searches (frequency, user_id);

-- Message bodies live in a Durable Object per conversation. This table holds
-- only the metadata needed for listing, sorting, and moderation.
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,     -- also the Durable Object name
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_count   INTEGER NOT NULL DEFAULT 0,
  risk_flags      TEXT,                 -- JSON array: ['offsite_payment_request', ...]
  last_message_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (listing_id, tenant_id)
);

CREATE INDEX idx_conversations_user ON conversations (tenant_id, last_message_at);
CREATE INDEX idx_conversations_landlord ON conversations (landlord_id, last_message_at);

-- ---------------------------------------------------------------------------
-- Trust and safety
-- ---------------------------------------------------------------------------

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  listing_id  TEXT REFERENCES listings(id) ON DELETE CASCADE,
  subject_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason IN ('suspected_scam', 'duplicate', 'already_rented', 'discriminatory', 'illegal_tenure', 'other')),
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reports_queue ON reports (status, created_at);

-- ---------------------------------------------------------------------------
-- Facebook migration instrumentation
-- ---------------------------------------------------------------------------

CREATE TABLE fb_crossposts (
  id           TEXT PRIMARY KEY,
  listing_id   TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('group_manual', 'page_api')),
  utm_campaign TEXT NOT NULL,
  composed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at    TEXT,
  UNIQUE (listing_id, channel)
);

CREATE INDEX idx_crossposts_pending ON fb_crossposts (posted_at, composed_at);
