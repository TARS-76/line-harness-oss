import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  checkSecretFile,
  consoleValues,
  liffEndpointUrl,
  loadSqlite,
  redact,
  run,
  validateManifest,
  verifyInvariance,
  type D1State,
  type StoreManifest,
} from './store-bootstrap';

// Fake credentials — shaped like the real ones so the shape checks pass.
const MSG_SECRET = 'a'.repeat(31) + '1';
const LOGIN_SECRET = 'b'.repeat(31) + '2';
const ADMIN_KEY = 'fake-admin-key-0123456789';
const TOKEN = 'fake-line-access-token-XYZ-0123456789';

function manifest(dir: string, over: Partial<StoreManifest['line']> = {}): StoreManifest {
  return {
    slug: 'store-c',
    name: '店舗C（架空）',
    line: { providerName: 'Store C Test', messagingChannelId: '9000000001', loginChannelId: '9000000002', liffId: '9000000002-AbCd1234', ...over },
    deployment: {
      adminApiUrl: 'http://127.0.0.1:8787',
      webhookBaseUrl: 'https://hooks.example.test',
      liffBaseUrl: 'https://liff.example.test/',
    },
    secretFiles: {
      messagingChannelSecret: join(dir, 'secrets', 'messaging'),
      loginChannelSecret: join(dir, 'secrets', 'login'),
      adminApiKey: join(dir, 'secrets', 'admin'),
    },
  };
}

function writeSecret(path: string, value: string, mode = 0o600) {
  writeFileSync(path, value + '\n');
  chmodSync(path, mode);
}

function fixtureStore(over: Partial<StoreManifest['line']> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'store-bootstrap-'));
  const storesDir = join(dir, 'stores');
  mkdirSync(join(storesDir, 'store-c'), { recursive: true });
  mkdirSync(join(dir, 'secrets'));
  const m = manifest(dir, over);
  writeFileSync(join(storesDir, 'store-c', 'store.json'), JSON.stringify(m, null, 2));
  writeSecret(m.secretFiles.messagingChannelSecret, MSG_SECRET);
  writeSecret(m.secretFiles.loginChannelSecret, LOGIN_SECRET);
  writeSecret(m.secretFiles.adminApiKey, ADMIN_KEY);
  return { dir, storesDir, m };
}

describe('validateManifest — the manifest is the only per-store input, so it must be exact', () => {
  const m = manifest('/tmp/x');
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(m, 'store-c')).toEqual([]);
  });
  it('rejects unknown keys so a secret cannot ride along in the manifest', () => {
    const bad = { ...m, line: { ...m.line, channelSecret: MSG_SECRET } };
    expect(validateManifest(bad, 'store-c').join()).toMatch(/line\.channelSecret: unknown key/);
  });
  it('requires liffId — a missing one would silently fall back to the global LIFF', () => {
    const { liffId: _, ...line } = m.line;
    expect(validateManifest({ ...m, line }, 'store-c').join()).toMatch(/line\.liffId: required/);
  });
  it('rejects a liffId that belongs to a different Login channel', () => {
    const bad = { ...m, line: { ...m.line, liffId: '1111111111-AbCd1234' } };
    expect(validateManifest(bad, 'store-c').join()).toMatch(/prefix must equal/);
  });
  it('rejects a slug that does not match the directory it was loaded from', () => {
    expect(validateManifest(m, 'store-d').join()).toMatch(/does not match --store/);
  });
  it('refuses a non-local admin API (v0.1 verifies against the local D1 only)', () => {
    const bad = { ...m, deployment: { ...m.deployment, adminApiUrl: 'https://prod.example.test' } };
    expect(validateManifest(bad, 'store-c').join()).toMatch(/local worker only/);
  });
  it('requires https for URLs pasted into the LINE Console', () => {
    const bad = { ...m, deployment: { ...m.deployment, webhookBaseUrl: 'http://hooks.example.test' } };
    expect(validateManifest(bad, 'store-c').join()).toMatch(/webhookBaseUrl: must be https/);
  });
});

describe('checkSecretFile — secrets only come from private files outside the repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-bootstrap-secret-'));
  it('accepts a 0600 file outside the repo', () => {
    const p = join(dir, 'ok');
    writeSecret(p, MSG_SECRET);
    expect(checkSecretFile('x', p).errors).toEqual([]);
  });
  it('rejects group/world-readable files', () => {
    const p = join(dir, 'loose');
    writeSecret(p, MSG_SECRET, 0o644);
    expect(checkSecretFile('x', p).errors.join()).toMatch(/must be 0600/);
  });
  it('rejects files inside the repository (they could be committed)', () => {
    expect(checkSecretFile('x', join(REPO_ROOT, 'package.json')).errors.join()).toMatch(/outside the repository/);
  });
  it('never echoes the file content in its errors', () => {
    const p = join(dir, 'loose2');
    writeSecret(p, MSG_SECRET, 0o644);
    expect(checkSecretFile('x', p).errors.join()).not.toContain(MSG_SECRET);
  });
});

describe('human-facing output', () => {
  const m = manifest('/tmp/x');
  it('appends ?liffId= so the LIFF app never falls back to the global default', () => {
    expect(liffEndpointUrl(m)).toBe('https://liff.example.test/?liffId=9000000002-AbCd1234');
  });
  it('lists only non-secret values', () => {
    const text = consoleValues(m, null);
    expect(text).toContain('https://hooks.example.test/webhook');
    expect(text).not.toMatch(/secretFiles|\/secrets\//);
  });
  it('redact() masks every known secret', () => {
    expect(redact(`x ${MSG_SECRET} y ${TOKEN}`, [MSG_SECRET, TOKEN])).toBe('x [REDACTED] y [REDACTED]');
  });
});

describe('verifyInvariance — only the known side effects of POST /api/line-accounts are allowed', () => {
  const base = (): D1State => ({
    tables: { bookings: { count: 1, digest: 'b' }, friends: { count: 1, digest: 'f' } },
    rows: {
      line_accounts: { A: { hash: 'hA' } },
      pool_accounts: { pA: { hash: 'hpA', poolId: 'main', lineAccountId: 'A' } },
      traffic_pools: { main: { hash: 'hm', slug: 'main' } },
      account_settings: { sA: { hash: 'hsA', lineAccountId: 'A', key: 'test_recipients' } },
    },
    lineAccounts: [{ id: 'A', channel_id: '1', login_channel_id: null, liff_id: null }],
    mainPoolId: 'main',
  });
  /** What the real POST adds: the row + main-pool membership (+ upstream's follower state). */
  const withNew = (s: D1State, followerState = true) => {
    s.rows.line_accounts.N = { hash: 'hN' };
    s.rows.pool_accounts.pN = { hash: 'hpN', poolId: s.mainPoolId!, lineAccountId: 'N' };
    if (followerState) s.rows.account_settings.sN = { hash: 'hsN', lineAccountId: 'N', key: 'follower_import_v1' };
    return s;
  };
  it('passes a normal registration including upstream follower_import_v1 state', () => {
    expect(verifyInvariance(base(), withNew(base()), 'N')).toEqual([]);
  });
  it('passes without follower_import_v1 (this fork has no capability probe yet)', () => {
    expect(verifyInvariance(base(), withNew(base(), false), 'N')).toEqual([]);
  });
  it('passes the first-account bootstrap that creates the main pool', () => {
    const pre = base();
    pre.rows.traffic_pools = {};
    pre.rows.pool_accounts = {};
    pre.mainPoolId = null;
    const post = structuredClone(pre);
    post.rows.traffic_pools.main = { hash: 'hm', slug: 'main', activeAccountId: 'N' };
    post.mainPoolId = 'main';
    expect(verifyInvariance(pre, withNew(post), 'N')).toEqual([]);
  });
  const freshTenant = () => {
    const pre = base();
    pre.rows.traffic_pools = {};
    pre.rows.pool_accounts = {};
    pre.mainPoolId = null;
    return pre;
  };
  it('fails when main existed but the new account was not enrolled (+1 membership is required)', () => {
    const post = withNew(base());
    delete post.rows.pool_accounts.pN;
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/pool_accounts: expected exactly 1/);
  });
  it('fails when the new account was enrolled twice', () => {
    const post = withNew(base());
    post.rows.pool_accounts.pN2 = { hash: 'x', poolId: 'main', lineAccountId: 'N' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/pool_accounts: expected exactly 1/);
  });
  it('fails when no main pool existed and none was created', () => {
    const post = structuredClone(freshTenant());
    post.rows.line_accounts.N = { hash: 'hN' };
    expect(verifyInvariance(freshTenant(), post, 'N').join()).toMatch(/no main before, expected exactly 1 main pool/);
  });
  it('fails when the bootstrapped main pool points at another account', () => {
    const post = structuredClone(freshTenant());
    post.rows.traffic_pools.main = { hash: 'hm', slug: 'main', activeAccountId: 'A' };
    post.mainPoolId = 'main';
    expect(verifyInvariance(freshTenant(), withNew(post), 'N').join()).toMatch(/traffic_pools: no main before/);
  });
  it('fails when the bootstrapped main pool has no membership for the new account', () => {
    const post = structuredClone(freshTenant());
    post.rows.traffic_pools.main = { hash: 'hm', slug: 'main', activeAccountId: 'N' };
    post.mainPoolId = 'main';
    post.rows.line_accounts.N = { hash: 'hN' };
    expect(verifyInvariance(freshTenant(), post, 'N').join()).toMatch(/pool_accounts: expected exactly 1/);
  });
  it('fails when an existing account row changed', () => {
    const post = withNew(base());
    post.rows.line_accounts.A = { hash: 'changed' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/line_accounts A: modified/);
  });
  it('fails when an existing store setting changed', () => {
    const post = withNew(base());
    post.rows.account_settings.sA = { ...post.rows.account_settings.sA, hash: 'changed' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/account_settings sA: modified/);
  });
  it('fails when an existing pool membership changed', () => {
    const post = withNew(base());
    post.rows.pool_accounts.pA = { ...post.rows.pool_accounts.pA, hash: 'changed' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/pool_accounts pA: modified/);
  });
  it('fails on an unknown setting even when it belongs to the new store', () => {
    const post = withNew(base(), false);
    post.rows.account_settings.sX = { hash: 'x', lineAccountId: 'N', key: 'something_else' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/account_settings: unexpected/);
  });
  it('fails when follower_import_v1 is written for an existing store', () => {
    const post = withNew(base(), false);
    post.rows.account_settings.sX = { hash: 'x', lineAccountId: 'A', key: 'follower_import_v1' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/account_settings: unexpected/);
  });
  it('fails when the new store is added to a pool other than main', () => {
    const post = withNew(base());
    post.rows.pool_accounts.pN = { hash: 'hpN', poolId: 'other', lineAccountId: 'N' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/pool_accounts: expected exactly 1/);
  });
  it('fails when an existing store is enrolled instead of the new one', () => {
    const post = withNew(base());
    post.rows.pool_accounts.pN = { hash: 'hpN', poolId: 'main', lineAccountId: 'A' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/pool_accounts: expected exactly 1/);
  });
  it('fails when a pool is created although main already existed', () => {
    const post = withNew(base());
    post.rows.traffic_pools.main2 = { hash: 'x', slug: 'main' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/traffic_pools: main existed, expected \+0/);
  });
  it('fails when a second pool appears although main already existed', () => {
    const post = withNew(base());
    post.rows.traffic_pools.other = { hash: 'x', slug: 'other' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/traffic_pools: main existed, expected \+0/);
  });
  it('fails when any unrelated table changed', () => {
    const post = withNew(base());
    post.tables.friends = { count: 2, digest: 'f2' };
    expect(verifyInvariance(base(), post, 'N').join()).toMatch(/table friends: changed/);
  });
});

// ─── end-to-end against a throwaway SQLite (needs node:sqlite, Node >= 22.16) ──

const nodeMajorMinor = process.versions.node.split('.').map(Number);
const hasSqlite = nodeMajorMinor[0] > 22 || (nodeMajorMinor[0] === 22 && nodeMajorMinor[1] >= 16);

describe.skipIf(!hasSqlite)('run() end-to-end with a fake worker (SKIPPED below Node 22.16)', async () => {
  const { DatabaseSync } = hasSqlite ? loadSqlite() : ({} as typeof import('node:sqlite'));

  function fixtureDb(dir: string, withMainPool = true) {
    const path = join(dir, 'd1.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE line_accounts (id TEXT PRIMARY KEY, channel_id TEXT UNIQUE, name TEXT, channel_access_token TEXT,
        channel_secret TEXT, login_channel_id TEXT, login_channel_secret TEXT, liff_id TEXT, is_active INTEGER,
        token_expires_at TEXT);
      CREATE TABLE traffic_pools (id TEXT PRIMARY KEY, slug TEXT UNIQUE, active_account_id TEXT);
      CREATE TABLE pool_accounts (id TEXT PRIMARY KEY, pool_id TEXT, line_account_id TEXT);
      CREATE TABLE bookings (id TEXT PRIMARY KEY, line_account_id TEXT);
      CREATE TABLE account_settings (id TEXT PRIMARY KEY, line_account_id TEXT, key TEXT, value TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(line_account_id, key));
      INSERT INTO account_settings VALUES ('as-existing','acct-existing','test_recipients','[]','t','t');
      INSERT INTO line_accounts VALUES ('acct-existing','1000000001','既存店','tok-existing','${'c'.repeat(32)}',NULL,NULL,'1000000002-Zz',1,'2026-10-19T00:00:00+09:00');
      ${withMainPool ? "INSERT INTO traffic_pools VALUES ('pool-main','main','acct-existing');" : ''}
      ${withMainPool ? "INSERT INTO pool_accounts VALUES ('pa-existing','pool-main','acct-existing');" : ''}
      INSERT INTO bookings VALUES ('bk-1','acct-existing');
    `);
    db.close();
    return path;
  }

  /** Mimics POST /api/line-accounts: insert the row + enroll into main pool. */
  function fakeWorker(dbPath: string, sideEffect?: (db: InstanceType<typeof DatabaseSync>) => void): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://api.line.me/v2/oauth/accessToken')) {
        return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 2592000, token_type: 'Bearer' }), { status: 200 });
      }
      const db = new DatabaseSync(dbPath);
      try {
        if (u.endsWith('/api/line-accounts') && (!init?.method || init.method === 'GET')) {
          const data = db.prepare('SELECT id FROM line_accounts').all();
          return new Response(JSON.stringify({ success: true, data }), { status: 200 });
        }
        if (u.endsWith('/api/line-accounts') && init?.method === 'POST') {
          const b = JSON.parse(String(init.body));
          db.prepare('INSERT INTO line_accounts VALUES (?,?,?,?,?,?,?,?,1,NULL)').run(
            'acct-new', b.channelId, b.name, b.channelAccessToken, b.channelSecret, b.loginChannelId, b.loginChannelSecret, b.liffId,
          );
          // Same as the route: addPoolAccount() into main, or createTrafficPool() on a fresh tenant
          const main = db.prepare("SELECT id FROM traffic_pools WHERE slug='main'").get() as { id: string } | undefined;
          if (!main) db.prepare("INSERT INTO traffic_pools VALUES ('pool-new','main','acct-new')").run();
          db.prepare('INSERT INTO pool_accounts VALUES (?,?,?)').run('pa-new', main?.id ?? 'pool-new', 'acct-new');
          // upstream detectFollowerImportCapability() (04327c4): capability state for the new account
          db.prepare("INSERT INTO account_settings VALUES ('as-new','acct-new','follower_import_v1','{\"capability\":\"available\"}','t','t')").run();
          sideEffect?.(db);
          // The real API echoes secrets in the 201 body (T-2); the script must not print them.
          return new Response(JSON.stringify({ success: true, data: { id: 'acct-new', channelSecret: b.channelSecret, channelAccessToken: b.channelAccessToken } }), { status: 201 });
        }
        return new Response('{}', { status: 404 });
      } finally {
        db.close();
      }
    }) as typeof fetch;
  }

  function collectAllText(dir: string, out: string[]) {
    const texts = [...out];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'journal.json') texts.push(readFileSync(p, 'utf8'));
      }
    };
    walk(dir);
    return texts.join('\n');
  }

  it('dry-run validates everything, prints console values, and writes nothing', async () => {
    const { dir, storesDir } = fixtureStore();
    const d1 = fixtureDb(dir);
    const before = readFileSync(d1);
    const out: string[] = [];
    const code = await run({ slug: 'store-c', execute: false, storesDir, d1Path: d1, out: (l) => out.push(l),
      fetchImpl: (() => { throw new Error('dry-run must not call the network'); }) as unknown as typeof fetch });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('?liffId=9000000002-AbCd1234');
    expect(readFileSync(d1).equals(before)).toBe(true);
    expect(readdirSync(join(storesDir, 'store-c'))).toEqual(['store.json']);
  });

  it('stops before any network call when the channel is already registered', async () => {
    const { dir, storesDir } = fixtureStore({ messagingChannelId: '1000000001' });
    const out: string[] = [];
    const code = await run({ slug: 'store-c', execute: true, storesDir, d1Path: fixtureDb(dir), out: (l) => out.push(l),
      fetchImpl: (() => { throw new Error('must not be called'); }) as unknown as typeof fetch });
    expect(code).toBe(1);
    expect(out.join()).toMatch(/already registered/);
  });

  it('execute registers via the API, verifies invariance, and never leaks a secret', async () => {
    const { dir, storesDir } = fixtureStore();
    const d1 = fixtureDb(dir);
    const out: string[] = [];
    const code = await run({ slug: 'store-c', execute: true, storesDir, d1Path: d1, backupDir: join(dir, 'backups'),
      fetchImpl: fakeWorker(d1), out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('line_accounts.id=acct-new');
    const all = collectAllText(storesDir, out);
    for (const s of [MSG_SECRET, LOGIN_SECRET, ADMIN_KEY, TOKEN]) expect(all).not.toContain(s);
  });

  it('execute passes on a fresh tenant where the API bootstraps the main pool', async () => {
    const { dir, storesDir } = fixtureStore();
    const d1 = fixtureDb(dir, false);
    const out: string[] = [];
    const code = await run({ slug: 'store-c', execute: true, storesDir, d1Path: d1, backupDir: join(dir, 'backups'),
      fetchImpl: fakeWorker(d1), out: (l) => out.push(l) });
    expect(out.join('\n')).not.toMatch(/STOP/);
    expect(code).toBe(0);
  });

  it('exits 2 when the registration also changed an existing store setting', async () => {
    const { dir, storesDir } = fixtureStore();
    const d1 = fixtureDb(dir);
    const out: string[] = [];
    const code = await run({ slug: 'store-c', execute: true, storesDir, d1Path: d1, backupDir: join(dir, 'backups'),
      fetchImpl: fakeWorker(d1, (db) => db.prepare("UPDATE account_settings SET value='[1]' WHERE id='as-existing'").run()),
      out: (l) => out.push(l) });
    expect(code).toBe(2);
    expect(out.join()).toMatch(/account_settings as-existing: modified/);
  });

  it('exits 2 (partial) when the registration also touched an existing store', async () => {
    const { dir, storesDir } = fixtureStore();
    const d1 = fixtureDb(dir);
    const out: string[] = [];
    const code = await run({ slug: 'store-c', execute: true, storesDir, d1Path: d1, backupDir: join(dir, 'backups'),
      fetchImpl: fakeWorker(d1, (db) => db.prepare("UPDATE bookings SET line_account_id='acct-new'").run()),
      out: (l) => out.push(l) });
    expect(code).toBe(2);
    expect(out.join()).toMatch(/table bookings: changed/);
    expect(out.join()).toMatch(/acct-new IS registered/);
  });
});
