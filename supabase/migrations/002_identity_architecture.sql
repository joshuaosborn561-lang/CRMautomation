-- CRM Autopilot — Identity-first architecture rebuild
-- Adds durable identity_map, aliases, meeting_links cache,
-- and repurposes review_queue for identity-resolution failures.

-- ============================================================
-- identity_map — one row per unique person across all sources.
-- UNIQUE(identity_key) is the single enforcement point for dedup.
-- ============================================================
CREATE TABLE IF NOT EXISTS identity_map (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  attio_person_id TEXT,
  attio_deal_id TEXT,
  attio_company_id TEXT,
  confidence TEXT CHECK (confidence IN ('verified','inferred','manual')) DEFAULT 'verified',
  merged_into UUID REFERENCES identity_map(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_map_attio_person ON identity_map(attio_person_id);
CREATE INDEX IF NOT EXISTS idx_identity_map_source ON identity_map(source);

ALTER TABLE identity_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON identity_map FOR ALL USING (true);

-- ============================================================
-- identity_aliases — multiple keys can point to the same canonical person
-- (e.g. email + linkedin + phone for one prospect).
-- ============================================================
CREATE TABLE IF NOT EXISTS identity_aliases (
  alias_key TEXT PRIMARY KEY,
  canonical_id UUID NOT NULL REFERENCES identity_map(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_aliases_canonical ON identity_aliases(canonical_id);

ALTER TABLE identity_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON identity_aliases FOR ALL USING (true);

-- ============================================================
-- meeting_links — Zoom meeting id → attendee email cache.
-- Populated from Gmail messages containing zoom.us/j/ URLs.
-- ============================================================
CREATE TABLE IF NOT EXISTS meeting_links (
  zoom_meeting_id TEXT PRIMARY KEY,
  attendee_email TEXT NOT NULL,
  gmail_message_id TEXT,
  meeting_topic TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_links_attendee ON meeting_links(attendee_email);

ALTER TABLE meeting_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON meeting_links FOR ALL USING (true);

-- ============================================================
-- webhook_events: add identity fields
-- ============================================================
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS identity_key TEXT,
  ADD COLUMN IF NOT EXISTS identity_resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_webhook_events_identity_key ON webhook_events(identity_key);

-- ============================================================
-- review_queue: extend with identity resolution columns.
-- Existing rows (source/proposed_action) stay valid;
-- new identity-resolution rows use reason/identity_hint/assigned_identity_key.
-- ============================================================
ALTER TABLE review_queue
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS identity_hint JSONB,
  ADD COLUMN IF NOT EXISTS assigned_identity_key TEXT,
  ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Make legacy columns nullable so new ingest rows don't need them.
ALTER TABLE review_queue ALTER COLUMN source DROP NOT NULL;
ALTER TABLE review_queue ALTER COLUMN proposed_action DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_queue_resolved ON review_queue(resolved) WHERE NOT resolved;
CREATE INDEX IF NOT EXISTS idx_review_queue_reason ON review_queue(reason);

-- ============================================================
-- resolve_or_create_identity — atomic find-or-create with advisory lock
-- so parallel webhook deliveries for the same person serialize at the DB.
-- ============================================================
CREATE OR REPLACE FUNCTION resolve_or_create_identity(
  p_identity_key TEXT,
  p_source TEXT
)
RETURNS TABLE (id UUID, attio_person_id TEXT, attio_deal_id TEXT, attio_company_id TEXT, is_new BOOLEAN) AS $$
DECLARE
  v_row identity_map%ROWTYPE;
BEGIN
  -- Serialize contention on the same key
  PERFORM pg_advisory_xact_lock(hashtext(p_identity_key));

  SELECT * INTO v_row FROM identity_map WHERE identity_key = p_identity_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_row.id, v_row.attio_person_id, v_row.attio_deal_id, v_row.attio_company_id, FALSE;
    RETURN;
  END IF;

  INSERT INTO identity_map (identity_key, source)
  VALUES (p_identity_key, p_source)
  RETURNING * INTO v_row;

  RETURN QUERY SELECT v_row.id, v_row.attio_person_id, v_row.attio_deal_id, v_row.attio_company_id, TRUE;
END;
$$ LANGUAGE plpgsql;
