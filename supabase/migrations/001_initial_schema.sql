-- CRM Autopilot - Database Schema
-- Run this against your Supabase project

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Webhook Events (raw incoming events)
-- ============================================================
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL CHECK (source IN ('smartlead', 'heyreach', 'zoom_phone', 'zoom_meeting', 'gmail')),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_events_processed ON webhook_events(processed) WHERE NOT processed;
CREATE INDEX idx_webhook_events_source ON webhook_events(source);
CREATE INDEX idx_webhook_events_received ON webhook_events(received_at DESC);

-- ============================================================
-- Interaction Log (processed timeline per contact)
-- ============================================================
CREATE TABLE interaction_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id TEXT,
  contact_email TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  raw_event_id UUID REFERENCES webhook_events(id),
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_interaction_log_contact ON interaction_log(contact_email);
CREATE INDEX idx_interaction_log_sentiment ON interaction_log(contact_email, sentiment);
CREATE INDEX idx_interaction_log_occurred ON interaction_log(occurred_at DESC);

-- ============================================================
-- Review Queue (pending Attio writes in review mode)
-- ============================================================
CREATE TABLE review_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID REFERENCES webhook_events(id),
  source TEXT NOT NULL,
  proposed_action JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto_applied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewer_notes TEXT
);

CREATE INDEX idx_review_queue_status ON review_queue(status) WHERE status = 'pending';

-- ============================================================
-- Supabase RPC: Get Nurture Candidates
-- Returns contacts who had a positive interaction before the
-- silence threshold and no subsequent positive interaction.
-- ============================================================
CREATE OR REPLACE FUNCTION get_nurture_candidates(silence_threshold TIMESTAMPTZ)
RETURNS TABLE (
  deal_id TEXT,
  contact_email TEXT,
  last_interaction_at TIMESTAMPTZ,
  last_interaction_summary TEXT,
  last_interaction_sentiment TEXT,
  last_outbound_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH positive_interactions AS (
    SELECT DISTINCT ON (il.contact_email)
      il.deal_id,
      il.contact_email,
      il.occurred_at AS last_positive_at,
      il.summary AS last_positive_summary
    FROM interaction_log il
    WHERE il.sentiment = 'positive'
    ORDER BY il.contact_email, il.occurred_at DESC
  ),
  latest_any AS (
    SELECT DISTINCT ON (il.contact_email)
      il.contact_email,
      il.occurred_at AS last_any_at
    FROM interaction_log il
    ORDER BY il.contact_email, il.occurred_at DESC
  )
  SELECT
    pi.deal_id,
    pi.contact_email,
    pi.last_positive_at AS last_interaction_at,
    pi.last_positive_summary AS last_interaction_summary,
    'positive'::TEXT AS last_interaction_sentiment,
    la.last_any_at AS last_outbound_at
  FROM positive_interactions pi
  JOIN latest_any la ON la.contact_email = pi.contact_email
  WHERE pi.last_positive_at < silence_threshold
    AND la.last_any_at < silence_threshold;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Row Level Security (disabled for service role access)
-- ============================================================
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so these policies allow the
-- webhook server (using service key) full access
CREATE POLICY "Service role full access" ON webhook_events FOR ALL USING (true);
CREATE POLICY "Service role full access" ON interaction_log FOR ALL USING (true);
CREATE POLICY "Service role full access" ON review_queue FOR ALL USING (true);

-- ============================================================
-- Gmail Sync State (tracks Pub/Sub history ID per account)
-- ============================================================
CREATE TABLE gmail_sync_state (
  email TEXT PRIMARY KEY,
  history_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE gmail_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON gmail_sync_state FOR ALL USING (true);
