-- 039_default_main_pool.sql
-- Create a default 'main' traffic pool if none exists, and enroll all
-- LINE accounts not already in any pool into it. This gives single-account
-- operators a visible Pool in the admin UI without forcing manual setup.

INSERT OR IGNORE INTO traffic_pools (
  id, slug, name, active_account_id, is_active, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  'main',
  'メインプール',
  (SELECT id FROM line_accounts ORDER BY created_at ASC LIMIT 1),
  1,
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
WHERE NOT EXISTS (SELECT 1 FROM traffic_pools WHERE slug = 'main')
  AND EXISTS (SELECT 1 FROM line_accounts);

-- Add LINE accounts not yet in any pool to the main pool.
-- pool_accounts schema (migration 019): id, pool_id, line_account_id, is_active, created_at
INSERT OR IGNORE INTO pool_accounts (
  id, pool_id, line_account_id, is_active, created_at
)
SELECT
  lower(hex(randomblob(16))),
  (SELECT id FROM traffic_pools WHERE slug = 'main'),
  la.id,
  1,
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
FROM line_accounts la
WHERE EXISTS (SELECT 1 FROM traffic_pools WHERE slug = 'main')
  AND NOT EXISTS (
    SELECT 1 FROM pool_accounts pa WHERE pa.line_account_id = la.id
  );
