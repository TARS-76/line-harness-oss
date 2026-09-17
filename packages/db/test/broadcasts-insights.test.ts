import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPendingInsights } from '../src/broadcasts.js';
import { toJstString } from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'));
  return db;
}

// Minimal D1 shim over better-sqlite3 — only what getPendingInsights touches.
function makeD1(db: Database.Database): D1Database {
  return {
    prepare: (sql: string) => ({
      all: async () => ({ results: db.prepare(sql).all() }),
    }),
  } as unknown as D1Database;
}

function seedPendingInsight(db: Database.Database, id: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, sent_at, created_at)
     VALUES (?, ?, 'text', '{}', 'all', 'sent', ?, ?)`,
  ).run(`b-${id}`, `bc ${id}`, sentAt, sentAt);
  db.prepare(
    `INSERT INTO broadcast_insights (id, broadcast_id, status) VALUES (?, ?, 'pending')`,
  ).run(`i-${id}`, `b-${id}`);
}

describe('getPendingInsights — 3-day threshold against +09:00 sent_at', () => {
  let raw: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    raw = loadDb();
    d1 = makeD1(raw);
  });

  // sent_at is written by jstNow() with a +09:00 suffix (updateBroadcastStatus).
  // SQLite normalises that offset to UTC inside julianday(), so the "now" side
  // must be plain UTC too. julianday('now', '+9 hours') double-counted the
  // offset and pulled insights 9 hours early: a broadcast sent 2 days 15 hours
  // ago looked 3 days old.
  it('does not pick up a broadcast sent 2 days 15 hours ago', async () => {
    seedPendingInsight(raw, 'young', toJstString(new Date(Date.now() - 2 * DAY - 15 * HOUR)));
    const rows = await getPendingInsights(d1);
    expect(rows.map((r) => r.insightId)).toEqual([]);
  });

  it('picks up a broadcast sent 3 days ago', async () => {
    const sentAt = toJstString(new Date(Date.now() - 3 * DAY - 60 * 1000));
    seedPendingInsight(raw, 'old', sentAt);
    const rows = await getPendingInsights(d1);
    expect(rows.map((r) => r.insightId)).toEqual(['i-old']);
    expect(rows[0].sentAt).toBe(sentAt);
  });

  it('separates the two when both exist', async () => {
    seedPendingInsight(raw, 'young', toJstString(new Date(Date.now() - 2 * DAY - 15 * HOUR)));
    seedPendingInsight(raw, 'old', toJstString(new Date(Date.now() - 3 * DAY - 60 * 1000)));
    const rows = await getPendingInsights(d1);
    expect(rows.map((r) => r.insightId)).toEqual(['i-old']);
  });
});
