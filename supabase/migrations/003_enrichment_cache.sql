-- CRM Autopilot — Enrichment cache on identity_map.
-- Every enrichment call writes the result back to these columns so
-- dry-runs, replays, and re-wipes never re-hit LeadMagic or Apollo
-- for a person we already know.

ALTER TABLE identity_map
  ADD COLUMN IF NOT EXISTS enriched_email        TEXT,
  ADD COLUMN IF NOT EXISTS enriched_first_name   TEXT,
  ADD COLUMN IF NOT EXISTS enriched_last_name    TEXT,
  ADD COLUMN IF NOT EXISTS enriched_phone        TEXT,
  ADD COLUMN IF NOT EXISTS enriched_linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS enriched_company      TEXT,
  ADD COLUMN IF NOT EXISTS enriched_title        TEXT,
  ADD COLUMN IF NOT EXISTS enriched_source       TEXT,
  ADD COLUMN IF NOT EXISTS enriched_at           TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_identity_map_enriched_email ON identity_map(enriched_email);
