-- Migration number: 0002 	 listings moderation + landlord verification state
--
-- Adds the moderation surface that listing submission needs: every new listing
-- lands in 'pending' and is only publicly visible once approved. Risk signals
-- from automated checks are stored alongside, so a human review always has the
-- machine's reasoning next to it.

-- Listings: moderation state and automated risk signals
ALTER TABLE listings ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE listings ADD COLUMN risk_score INTEGER;
ALTER TABLE listings ADD COLUMN risk_flags TEXT;          -- JSON array of flag objects
ALTER TABLE listings ADD COLUMN reviewed_at TEXT;
ALTER TABLE listings ADD COLUMN reviewed_note TEXT;
ALTER TABLE listings ADD COLUMN contact_email TEXT;
ALTER TABLE listings ADD COLUMN updated_at TEXT;

-- Landlords: richer verification state than the original boolean
ALTER TABLE landlords ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE landlords ADD COLUMN risk_notes TEXT;

-- An audit trail for every automated check and manual decision. Append-only:
-- never update a row here, always insert a new one.
CREATE TABLE IF NOT EXISTS moderation_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('listing','landlord')),
  subject_id   TEXT NOT NULL,
  actor        TEXT NOT NULL,        -- 'auto:<check-name>' or 'human:<who>'
  action       TEXT NOT NULL,        -- flagged | approved | rejected | note
  detail       TEXT,                 -- JSON: score, reasoning, model used
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_moderation ON listings(moderation_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mod_events_subject  ON moderation_events(subject_type, subject_id, created_at DESC);
