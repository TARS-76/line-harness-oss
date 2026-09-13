-- Migration 029: Account Management v2 + 重複除外配信
-- See: docs/superpowers/specs/2026-05-06-account-management-v2-design.md
--
-- This migration is split across two implementation tasks (Task 1 = this commit,
-- Task 2 = upcoming). Both parts will append into THIS file, and the entire
-- combined migration applies atomically as a single _migrations entry on the
-- next D1 deploy. The split exists for review-cycle granularity, not for
-- separate deploys.
--
-- Part 1 (Task 1, this commit):
--   line_accounts.country / role / display_order + index + backfill
-- Part 2 (Task 2, upcoming):
--   broadcasts.account_ids / dedup_priority / failed_account_ids + json_valid CHECK
--   (plus an optional table recreate if the production broadcasts table has a
--    target_type CHECK constraint that needs to expand)

-- ============================================================
-- Part 1: line_accounts extensions
-- ============================================================

-- country: free-text (e.g., '日本' / 'Japan' / 'タイ' / 'Thailand').
--          Client-side lookup table maps to flag emoji; unrecognized
--          values render without a flag (graceful degrade).
-- role:    free-text (e.g., '本店' / 'プロモ' / '実験').
--          Display-only metadata, no business logic depends on its value.
ALTER TABLE line_accounts ADD COLUMN country TEXT;
ALTER TABLE line_accounts ADD COLUMN role TEXT;
ALTER TABLE line_accounts ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_line_accounts_display_order
  ON line_accounts (display_order, created_at);

-- Backfill display_order = position by created_at ASC (0, 1, 2, ...).
-- We use a correlated subquery; SQLite 3.25+ also supports ROW_NUMBER() OVER
-- but the correlated form is simpler and the row count here is single digits.
--
-- Tie-break on id: if two rows share the same created_at (millisecond-precision
-- collision is theoretically possible during seed scripts), id ASC decides which
-- comes first. This makes the backfill fully deterministic across re-runs and
-- across replicas.
--
-- Concurrency: an INSERT racing between ALTER TABLE ADD COLUMN and this UPDATE
-- would receive display_order = 0 (the column default), then have its rank
-- recomputed by this UPDATE's WHERE display_order = 0 clause. Acceptable risk
-- with D1's single-writer semantics and a deploy window of milliseconds.
UPDATE line_accounts SET display_order = (
  SELECT COUNT(*) FROM line_accounts la2
  WHERE la2.created_at < line_accounts.created_at
     OR (la2.created_at = line_accounts.created_at AND la2.id < line_accounts.id)
) WHERE display_order = 0;

-- ============================================================
-- Part 2: broadcasts dedup metadata (table recreate)
-- ============================================================
-- Production broadcasts.target_type CHECK = ('all', 'tag') only.
-- We expand to ('all', 'tag', 'segment', 'multi-account-dedup'). 'segment' is
-- preserved as forward-compatible (segment_conditions column already exists in
-- production but the CHECK never permitted the matching target_type; including
-- it now avoids a silent block when segment broadcasts are wired up).
-- SQLite cannot ALTER CHECK in place; pattern follows migrations/027_dedup_delivery.sql.
--
-- Existing data shape verified 2026-05-06 via Mac Mini SSH:
--   - 18 columns (12 original + 6 ALTER-added trailing)
--   - status DISTINCT = ('draft', 'sent') in production
--     -> new CHECK ('draft','scheduled','sending','sent') is a safe superset
--   - 1 explicit index: idx_broadcasts_status; PK autoindex re-created on rename

CREATE TABLE broadcasts_new (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content    TEXT NOT NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
  target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at       TEXT,
  sent_at            TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  line_account_id    TEXT,
  alt_text           TEXT,
  line_request_id    TEXT,
  aggregation_unit   TEXT,
  batch_offset       INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids))
);

INSERT INTO broadcasts_new (
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_account_id, alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions
) SELECT
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_account_id, alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions
FROM broadcasts;

DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;

CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts (status);

-- Invariants (enforced in application code, not the schema):
--   * dedup_priority ⊆ account_ids
--   * account_ids - dedup_priority: missing accounts get the trailing slot (created_at ASC fallback)
--   * len(account_ids) == 1: dedup_priority ignored, single-account multicast equivalence
