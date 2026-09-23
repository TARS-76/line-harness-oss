#!/usr/bin/env tsx
/**
 * Store Template v0.1 — register one store (LINE account) from an instance
 * manifest, and verify that nothing else changed.
 *
 * This is a thin composition of existing primitives, not a new code path:
 *   - LINE `POST /v2/oauth/accessToken` (client_credentials) — the same call
 *     `services/token-refresh.ts` makes
 *   - `POST /api/line-accounts` — the only registration path (no direct D1
 *     INSERT). Its known side effects (main pool enrollment, upstream's
 *     follower-import capability state) are an explicit allowlist.
 *   - read-only `node:sqlite` inspection of the local D1 for before/after state
 *
 * The human-side LINE Console work is in docs/store-onboarding-checklist.md.
 *
 * Usage (Node >= 22.16 for node:sqlite backup):
 *   tsx scripts/store-bootstrap.ts --store <slug>             # dry-run (default)
 *   tsx scripts/store-bootstrap.ts --store <slug> --execute   # registers
 *
 * Manifest: ~/.line-harness-poc/stores/<slug>/store.json (never in the repo).
 * Secrets are read from 0600 files outside the repo, referenced by path only.
 * Secret values never reach argv, stdout, the journal, or the evidence files.
 *
 * Exit codes: 0 ok / 1 stopped before any write / 2 stopped after a write
 * (read the run journal to see which steps completed).
 *
 * Scheduled handler is deliberately NOT invoked: it is global (step
 * deliveries, broadcasts, booking reminders, health logs for every store).
 * The new row keeps token_expires_at = NULL, and the next regular tick's
 * refreshLineAccessTokens() starts tracking it — the existing behaviour.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STORES_DIR = join(homedir(), '.line-harness-poc', 'stores');
export const DEFAULT_BACKUP_DIR = join(homedir(), '.line-harness-poc', 'd1-backups');
const D1_DIR = join(REPO_ROOT, 'apps/worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject');

// Tables POST /api/line-accounts may add rows to (expected-delta allowlist,
// see verifyInvariance). Everything else must be byte-identical before and
// after, and pre-existing rows in these tables must not change either.
const TOUCHED = ['line_accounts', 'pool_accounts', 'traffic_pools', 'account_settings'] as const;
type Touched = (typeof TOUCHED)[number];

// Written by upstream's detectFollowerImportCapability() at registration
// (upstream 04327c4, not yet in this fork's main). Allowed, never required:
// the probe is non-fatal there and absent here.
export const FOLLOWER_IMPORT_STATE_KEY = 'follower_import_v1';

// ─── manifest ───────────────────────────────────────────────────────────────

export interface StoreManifest {
  slug: string;
  name: string;
  line: {
    providerName: string;
    messagingChannelId: string;
    loginChannelId: string;
    liffId: string;
  };
  deployment: {
    adminApiUrl: string;
    webhookBaseUrl: string;
    liffBaseUrl: string;
  };
  secretFiles: {
    messagingChannelSecret: string;
    loginChannelSecret: string;
    adminApiKey: string;
  };
}

const SHAPE: Record<string, readonly string[]> = {
  '': ['slug', 'name', 'line', 'deployment', 'secretFiles'],
  line: ['providerName', 'messagingChannelId', 'loginChannelId', 'liffId'],
  deployment: ['adminApiUrl', 'webhookBaseUrl', 'liffBaseUrl'],
  secretFiles: ['messagingChannelSecret', 'loginChannelSecret', 'adminApiKey'],
};

/** Strict: unknown keys are rejected so nothing (e.g. a secret) rides along. */
export function validateManifest(raw: unknown, expectedSlug: string): string[] {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(raw)) return ['manifest must be a JSON object'];

  for (const [section, keys] of Object.entries(SHAPE)) {
    const obj = section === '' ? raw : raw[section];
    const where = section || '(root)';
    if (!isObj(obj)) { errors.push(`${where}: must be an object`); continue; }
    for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${where}.${k}: unknown key`);
    for (const k of keys) {
      if (section === '' && SHAPE[k]) continue;
      if (typeof obj[k] !== 'string' || !(obj[k] as string).trim()) errors.push(`${where}.${k}: required non-empty string`);
    }
  }
  if (errors.length) return errors;

  const m = raw as unknown as StoreManifest;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(m.slug)) errors.push('slug: lowercase letters, digits, "-"');
  if (m.slug !== expectedSlug) errors.push(`slug: "${m.slug}" does not match --store "${expectedSlug}"`);
  if (!/^\d+$/.test(m.line.messagingChannelId)) errors.push('line.messagingChannelId: digits only');
  if (!/^\d+$/.test(m.line.loginChannelId)) errors.push('line.loginChannelId: digits only');
  if (m.line.messagingChannelId === m.line.loginChannelId) {
    errors.push('line.loginChannelId: must differ from messagingChannelId (separate LINE Login channel)');
  }
  // liffId is mandatory: a store without it would fall back to the global
  // LIFF (VITE_DEFAULT_LIFF_ID) and book against the wrong account.
  const liff = /^(\d+)-[A-Za-z0-9]+$/.exec(m.line.liffId);
  if (!liff) errors.push('line.liffId: format <loginChannelId>-<suffix>');
  else if (liff[1] !== m.line.loginChannelId) errors.push('line.liffId: prefix must equal line.loginChannelId');

  for (const k of ['adminApiUrl', 'webhookBaseUrl', 'liffBaseUrl'] as const) {
    let u: URL | null = null;
    try { u = new URL(m.deployment[k]); } catch { errors.push(`deployment.${k}: not a URL`); continue; }
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (k === 'adminApiUrl') {
      // ponytail: local worker only (v0.1 = verification mode). Remote D1 +
      // deployed worker needs a wrangler-based state reader.
      if (!local) errors.push('deployment.adminApiUrl: v0.1 supports the local worker only');
    } else if (u.protocol !== 'https:') {
      errors.push(`deployment.${k}: must be https (LINE requires it)`);
    }
    if (k === 'liffBaseUrl' && u.searchParams.has('liffId')) {
      errors.push('deployment.liffBaseUrl: must not contain liffId (it is appended per store)');
    }
  }
  return errors;
}

// ─── secret files ───────────────────────────────────────────────────────────

export interface SecretCheck { path: string; errors: string[] }

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/** Validate a secret file without ever returning its content in errors. */
export function checkSecretFile(label: string, p: string, repoRoot = REPO_ROOT): SecretCheck {
  const path = expandHome(p);
  const errors: string[] = [];
  if (!isAbsolute(path)) return { path, errors: [`${label}: path must be absolute or ~/…`] };
  if (!existsSync(path)) return { path, errors: [`${label}: file not found (${path})`] };
  const st = lstatSync(path);
  if (st.isSymbolicLink()) errors.push(`${label}: must not be a symlink`);
  else if (!st.isFile()) errors.push(`${label}: not a regular file`);
  if ((st.mode & 0o077) !== 0) errors.push(`${label}: mode ${(st.mode & 0o777).toString(8)} — must be 0600`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) errors.push(`${label}: not owned by current user`);
  const real = existsSync(path) && !st.isSymbolicLink() ? realpathSync(path) : path;
  const root = realpathSync(repoRoot);
  if (real === root || real.startsWith(root + sep)) errors.push(`${label}: must live outside the repository`);
  return { path, errors };
}

const SECRET_SHAPE: Record<keyof StoreManifest['secretFiles'], RegExp> = {
  messagingChannelSecret: /^[0-9a-f]{32}$/,
  loginChannelSecret: /^[0-9a-f]{32}$/,
  adminApiKey: /^\S{16,}$/,
};

export type Secrets = Record<keyof StoreManifest['secretFiles'], string>;

export function readSecrets(m: StoreManifest, repoRoot = REPO_ROOT): { secrets?: Secrets; errors: string[] } {
  const errors: string[] = [];
  const out: Partial<Secrets> = {};
  for (const key of Object.keys(SECRET_SHAPE) as (keyof Secrets)[]) {
    const chk = checkSecretFile(`secretFiles.${key}`, m.secretFiles[key], repoRoot);
    if (chk.errors.length) { errors.push(...chk.errors); continue; }
    const value = readFileSync(chk.path, 'utf8').trim();
    if (!SECRET_SHAPE[key].test(value)) errors.push(`secretFiles.${key}: content has unexpected shape (value not shown)`);
    else out[key] = value;
  }
  if (errors.length) return { errors };
  const s = out as Secrets;
  if (s.messagingChannelSecret === s.loginChannelSecret) {
    errors.push('secretFiles: messaging and login channel secrets are identical — wrong file?');
  }
  return errors.length ? { errors } : { secrets: s, errors };
}

/** Replace every known secret value with a marker. Applied to all output. */
export function redact(text: string, secrets: readonly string[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join('[REDACTED]');
  return t;
}

// ─── D1 state (read-only) ───────────────────────────────────────────────────

export interface D1State {
  tables: Record<string, { count: number; digest: string }>;
  // id → row sha256 + the non-secret columns the allowlist needs
  rows: Record<Touched, Record<string, RowInfo>>;
  lineAccounts: Array<{ id: string; channel_id: string; login_channel_id: string | null; liff_id: string | null }>;
  mainPoolId: string | null;
}

export interface RowInfo {
  hash: string;
  lineAccountId?: string;
  poolId?: string;
  key?: string;
  slug?: string;
  activeAccountId?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

export function locateLocalD1(dir = D1_DIR): string {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite') : [];
  if (files.length !== 1) throw new Error(`expected exactly 1 local D1 sqlite in ${dir}, found ${files.length}`);
  return join(dir, files[0]);
}

// Loaded at runtime (not a static import): node:sqlite needs Node >= 22 and
// Vite 5 (vitest) cannot resolve it statically.
export function loadSqlite(): typeof import('node:sqlite') {
  return createRequire(import.meta.url)('node:sqlite');
}

async function openReadOnly(path: string) {
  return new (loadSqlite().DatabaseSync)(path, { readOnly: true });
}

export async function readState(dbPath: string): Promise<D1State> {
  const db = await openReadOnly(dbPath);
  try {
    const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    const names = all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' ORDER BY name",
    ).map((r) => String(r.name));
    const state: D1State = {
      tables: {},
      rows: { line_accounts: {}, pool_accounts: {}, traffic_pools: {}, account_settings: {} },
      lineAccounts: [],
      mainPoolId: null,
    };
    for (const t of names) {
      const rows = all(`SELECT * FROM "${t}" ORDER BY rowid`);
      state.tables[t] = { count: rows.length, digest: sha(JSON.stringify(rows)) };
      if ((TOUCHED as readonly string[]).includes(t)) {
        for (const r of rows) {
          state.rows[t as Touched][String(r.id)] = {
            hash: sha(JSON.stringify(r)),
            lineAccountId: str(r.line_account_id),
            poolId: str(r.pool_id),
            key: str(r.key),
            slug: str(r.slug),
            activeAccountId: str(r.active_account_id),
          };
        }
      }
    }
    state.lineAccounts = all('SELECT id, channel_id, login_channel_id, liff_id FROM line_accounts') as D1State['lineAccounts'];
    const main = all("SELECT id FROM traffic_pools WHERE slug='main'");
    state.mainPoolId = main.length ? String(main[0].id) : null;
    return state;
  } finally {
    db.close();
  }
}

/** Identifiers that would make POST /api/line-accounts collide (409). */
export function findCollisions(m: StoreManifest, s: D1State): string[] {
  const out: string[] = [];
  for (const a of s.lineAccounts) {
    if (a.channel_id === m.line.messagingChannelId) out.push(`messagingChannelId already registered (line_accounts.id=${a.id})`);
    if (a.login_channel_id === m.line.loginChannelId) out.push(`loginChannelId already used (line_accounts.id=${a.id})`);
    if (a.liff_id === m.line.liffId) out.push(`liffId already used (line_accounts.id=${a.id})`);
  }
  return out;
}

/**
 * Pure diff against the expected delta of POST /api/line-accounts, derived
 * from the pre-state (packages/db traffic-pools.ts):
 *   - line_accounts:    exactly the new account
 *   - main pool existed → addPoolAccount():
 *       traffic_pools +0, pool_accounts exactly 1 = (existing main, new account)
 *   - no main pool      → createTrafficPool({ slug: 'main', activeAccountId }):
 *       traffic_pools exactly 1 = slug 'main' / active = new account,
 *       pool_accounts exactly 1 = (that new pool, new account)
 *   - account_settings: 0 or 1 row = (new account, follower_import_v1)
 * Every pre-existing row and every other table must be identical. Unknown
 * additions — including ones scoped to the new account — fail.
 */
export function verifyInvariance(pre: D1State, post: D1State, newId: string): string[] {
  const problems: string[] = [];
  const tables = new Set([...Object.keys(pre.tables), ...Object.keys(post.tables)]);
  for (const t of tables) {
    if ((TOUCHED as readonly string[]).includes(t)) continue;
    const a = pre.tables[t], b = post.tables[t];
    if (!a || !b) problems.push(`table ${t}: ${a ? 'disappeared' : 'appeared'}`);
    else if (a.digest !== b.digest) problems.push(`table ${t}: changed (${a.count} → ${b.count} rows)`);
  }
  for (const t of TOUCHED) {
    for (const [id, r] of Object.entries(pre.rows[t])) {
      if (post.rows[t][id] === undefined) problems.push(`${t} ${id}: deleted`);
      else if (post.rows[t][id].hash !== r.hash) problems.push(`${t} ${id}: modified`);
    }
  }
  const added = (t: Touched) =>
    Object.entries(post.rows[t]).filter(([id]) => !(id in pre.rows[t])).map(([id, r]) => ({ id, ...r }));

  const la = added('line_accounts').map((r) => r.id);
  if (la.length !== 1 || la[0] !== newId) problems.push(`line_accounts: expected exactly [${newId}] added, got [${la.join(', ')}]`);

  // The main pool the new account must end up in: the pre-existing one, or
  // exactly one freshly bootstrapped `main` pool whose active account is new.
  const tp = added('traffic_pools');
  let expectedPoolId: string | null = null;
  if (pre.mainPoolId) {
    if (tp.length !== 0) problems.push(`traffic_pools: main existed, expected +0, got [${tp.map((r) => r.id).join(', ')}]`);
    else expectedPoolId = pre.mainPoolId;
  } else if (tp.length !== 1 || tp[0].slug !== 'main' || tp[0].activeAccountId !== newId) {
    problems.push(`traffic_pools: no main before, expected exactly 1 main pool active=${newId}, got [${tp.map((r) => `${r.id}/${r.slug}`).join(', ')}]`);
  } else {
    expectedPoolId = tp[0].id;
  }

  const pa = added('pool_accounts');
  if (pa.length !== 1 || pa[0].lineAccountId !== newId || !expectedPoolId || pa[0].poolId !== expectedPoolId) {
    problems.push(`pool_accounts: expected exactly 1 = (${expectedPoolId ?? 'main'}, ${newId}), got [${pa.map((r) => `${r.poolId}/${r.lineAccountId}`).join(', ')}]`);
  }

  const as = added('account_settings');
  const settingOk = as.length === 0 || (as.length === 1 && as[0].lineAccountId === newId && as[0].key === FOLLOWER_IMPORT_STATE_KEY);
  if (!settingOk) {
    problems.push(`account_settings: unexpected additions [${as.map((r) => `${r.lineAccountId}/${r.key}`).join(', ')}]`);
  }
  return problems;
}

// ─── human-facing output (non-secret only) ──────────────────────────────────

export function liffEndpointUrl(m: StoreManifest): string {
  const u = new URL(m.deployment.liffBaseUrl);
  u.searchParams.set('liffId', m.line.liffId);
  return u.toString();
}

export function consoleValues(m: StoreManifest, accountId: string | null): string {
  const base = m.deployment.webhookBaseUrl.replace(/\/$/, '');
  return [
    `== LINE Console に設定する値（${m.name} / ${m.slug}）==`,
    `  Provider                       : ${m.line.providerName}`,
    `  Messaging API channel ID        : ${m.line.messagingChannelId}`,
    `    Webhook URL                   : ${base}/webhook`,
    `  LINE Login channel ID           : ${m.line.loginChannelId}`,
    `    LIFF ID                       : ${m.line.liffId}`,
    `    LIFF Endpoint URL             : ${liffEndpointUrl(m)}`,
    `  line_accounts.id                : ${accountId ?? '(未登録 — --execute 後に確定)'}`,
    `  次の人手作業 → docs/store-onboarding-checklist.md §3 以降`,
  ].join('\n');
}

// ─── run journal (non-secret; tells what completed after a partial run) ─────

interface Journal { slug: string; startedAt: string; mode: string; steps: Array<{ step: string; status: 'ok' | 'fail'; at: string; detail?: unknown }> }

function makeJournal(dir: string, slug: string, mode: string, secrets: () => string[]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const j: Journal = { slug, startedAt: new Date().toISOString(), mode, steps: [] };
  const path = join(dir, 'journal.json');
  return {
    path,
    record(step: string, status: 'ok' | 'fail', detail?: unknown) {
      j.steps.push({ step, status, at: new Date().toISOString(), detail });
      writeFileSync(path, redact(JSON.stringify(j, null, 2), secrets()) + '\n', { mode: 0o600 });
    },
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

export interface RunOptions {
  slug: string;
  execute: boolean;
  storesDir?: string;
  backupDir?: string;
  d1Path?: string;
  repoRoot?: string;
  fetchImpl?: typeof fetch;
  out?: (line: string) => void;
}

export async function run(o: RunOptions): Promise<number> {
  const storesDir = o.storesDir ?? DEFAULT_STORES_DIR;
  const f = o.fetchImpl ?? fetch;
  let secretValues: string[] = [];
  let token = '';
  const say = (line: string) => (o.out ?? console.log)(redact(line, [...secretValues, token]));
  const stop = (code: number, msg: string[]) => { for (const l of msg) say(`STOP: ${l}`); return code; };

  // 1. preflight — manifest
  const manifestPath = join(storesDir, o.slug, 'store.json');
  if (!existsSync(manifestPath)) return stop(1, [`manifest not found: ${manifestPath}`]);
  let raw: unknown;
  const manifestText = readFileSync(manifestPath, 'utf8');
  try { raw = JSON.parse(manifestText); } catch { return stop(1, ['manifest is not valid JSON']); }
  const mErr = validateManifest(raw, o.slug);
  if (mErr.length) return stop(1, mErr);
  const m = raw as StoreManifest;

  // 1b. preflight — secret files (content stays in memory)
  const { secrets, errors: sErr } = readSecrets(m, o.repoRoot);
  if (!secrets) return stop(1, sErr);
  secretValues = Object.values(secrets);
  if (secretValues.some((v) => manifestText.includes(v))) return stop(1, ['manifest contains a secret value — remove it']);

  // 1c. preflight — D1 identity + collisions
  let dbPath: string;
  try { dbPath = o.d1Path ?? locateLocalD1(); } catch (e) { return stop(1, [(e as Error).message]); }
  const pre = await readState(dbPath);
  const collisions = findCollisions(m, pre);
  if (collisions.length) return stop(1, collisions);

  say(`preflight OK: manifest / secret files (0600, outside repo) / no collisions among ${pre.lineAccounts.length} existing accounts`);
  if (!o.execute) {
    say(consoleValues(m, null));
    say('dry-run: nothing written, no network calls. Re-run with --execute to register.');
    return 0;
  }

  const runDir = join(storesDir, o.slug, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  const journal = makeJournal(runDir, o.slug, 'execute', () => [...secretValues, token]);
  journal.record('preflight', 'ok', { manifestPath, d1: dbPath, existingAccounts: pre.lineAccounts.length });

  // 1d. the worker must be serving this exact D1, otherwise verification is meaningless
  const api = m.deployment.adminApiUrl.replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${secrets.adminApiKey}` };
  try {
    const res = await f(`${api}/api/line-accounts`, { headers: auth });
    if (res.status !== 200) throw new Error(`GET /api/line-accounts → ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const apiIds = (body.data ?? []).map((a) => a.id).sort().join(',');
    const dbIds = pre.lineAccounts.map((a) => a.id).sort().join(',');
    if (apiIds !== dbIds) throw new Error('worker line_accounts differ from the local D1 being inspected');
  } catch (e) {
    journal.record('worker-check', 'fail', (e as Error).message);
    return stop(1, [(e as Error).message, `journal: ${journal.path}`]);
  }
  journal.record('worker-check', 'ok');

  // 2. backup (contains every store's secrets → kept out of evidence, 0600)
  const backupDir = join(o.backupDir ?? DEFAULT_BACKUP_DIR, `store-bootstrap-${o.slug}-${runDir.split(sep).pop()}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = join(backupDir, 'd1.sqlite');
  const sqlite = loadSqlite();
  const src = await openReadOnly(dbPath);
  try { await sqlite.backup(src, backupPath); } finally { src.close(); }
  chmodSync(backupPath, 0o600);
  const preRecheck = await readState(dbPath);
  if (JSON.stringify(preRecheck.tables) !== JSON.stringify(pre.tables)) {
    journal.record('backup', 'fail', 'D1 changed during preflight');
    return stop(1, ['D1 changed between preflight and backup — concurrent writes; retry when idle', `journal: ${journal.path}`]);
  }
  journal.record('backup', 'ok', { backupPath, sha256: createHash('sha256').update(readFileSync(backupPath)).digest('hex') });

  // 4. token (LINE client_credentials; value never logged)
  try {
    const res = await f('https://api.line.me/v2/oauth/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: m.line.messagingChannelId,
        client_secret: secrets.messagingChannelSecret,
      }),
    });
    if (!res.ok) throw new Error(`LINE token API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const t = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!t.access_token) throw new Error('LINE token API: no access_token in response');
    token = t.access_token;
    journal.record('token', 'ok', { expiresInSec: t.expires_in ?? null });
  } catch (e) {
    journal.record('token', 'fail', (e as Error).message);
    return stop(1, [(e as Error).message, 'nothing was written to D1', `journal: ${journal.path}`]);
  }

  // 5. register via the canonical API. The 201 body echoes secrets in
  //    plaintext (T-2) — only data.id is read from it.
  let newId: string;
  try {
    const res = await f(`${api}/api/line-accounts`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: m.line.messagingChannelId,
        name: m.name,
        channelAccessToken: token,
        channelSecret: secrets.messagingChannelSecret,
        loginChannelId: m.line.loginChannelId,
        loginChannelSecret: secrets.loginChannelSecret,
        liffId: m.line.liffId,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }; error?: string };
    if (res.status !== 201 || !body.data?.id) throw new Error(`POST /api/line-accounts → ${res.status} ${body.error ?? ''}`.trim());
    newId = body.data.id;
    journal.record('register', 'ok', { lineAccountId: newId });
  } catch (e) {
    journal.record('register', 'fail', (e as Error).message);
    // The API may still have written before failing — check instead of assuming.
    const after = await readState(dbPath);
    const landed = after.lineAccounts.find((a) => a.channel_id === m.line.messagingChannelId);
    return stop(landed ? 2 : 1, [
      (e as Error).message,
      landed ? `but line_accounts row ${landed.id} exists — inspect before retrying` : 'no line_accounts row was created',
      `backup: ${backupPath}`,
      `journal: ${journal.path}`,
    ]);
  }

  // 6. scheduled: intentionally not invoked (see header).
  journal.record('scheduled', 'ok', 'skipped by design — next regular tick sets token_expires_at');

  // 7–9. post-state + verification
  const post = await readState(dbPath);
  const problems = verifyInvariance(pre, post, newId);
  const db = await openReadOnly(dbPath);
  try {
    const row = db.prepare('SELECT * FROM line_accounts WHERE id = ?').get(newId) as Record<string, unknown> | undefined;
    const expect: Array<[string, unknown, unknown]> = row
      ? [
          ['channel_id', row.channel_id, m.line.messagingChannelId],
          ['name', row.name, m.name],
          ['login_channel_id', row.login_channel_id, m.line.loginChannelId],
          ['liff_id', row.liff_id, m.line.liffId],
          ['is_active', row.is_active, 1],
          ['channel_secret', row.channel_secret === secrets.messagingChannelSecret, true],
          ['login_channel_secret', row.login_channel_secret === secrets.loginChannelSecret, true],
          ['channel_access_token', row.channel_access_token === token, true],
          ['token_expires_at', row.token_expires_at, null],
        ]
      : [];
    if (!row) problems.push(`line_accounts ${newId}: not found after 201`);
    for (const [k, got, want] of expect) {
      if (got !== want) problems.push(`line_accounts.${k}: unexpected value${typeof want === 'boolean' ? ' (secret mismatch)' : ''}`);
    }
    const mainId = post.mainPoolId;
    const inPool = mainId
      ? db.prepare('SELECT 1 FROM pool_accounts WHERE pool_id = ? AND line_account_id = ?').get(mainId, newId)
      : undefined;
    if (!inPool) problems.push('pool_accounts: new account is not enrolled in the main pool');
  } finally {
    db.close();
  }

  if (problems.length) {
    journal.record('verify', 'fail', problems);
    return stop(2, [...problems, `account ${newId} IS registered; backup: ${backupPath}`, `journal: ${journal.path}`]);
  }
  journal.record('verify', 'ok', {
    lineAccountId: newId,
    unchangedTables: Object.keys(post.tables).filter((t) => !(TOUCHED as readonly string[]).includes(t)).length,
    preExistingAccountsUnchanged: pre.lineAccounts.length,
  });

  // 10. non-secret values for the human
  say(`registered: line_accounts.id=${newId} — ${pre.lineAccounts.length} existing accounts and all other tables unchanged`);
  say(consoleValues(m, newId));
  say(`journal: ${journal.path}`);
  return 0;
}

function parseArgs(argv: string[]): { slug?: string; execute: boolean; error?: string } {
  let slug: string | undefined;
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--store') slug = argv[++i];
    else if (argv[i] === '--execute') execute = true;
    else if (argv[i] === '--dry-run') execute = false;
    else return { execute, error: `unknown argument: ${argv[i]}` };
  }
  return slug ? { slug, execute } : { execute, error: 'usage: store-bootstrap.ts --store <slug> [--execute]' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) { console.error(a.error); process.exit(1); }
  run({ slug: a.slug!, execute: a.execute })
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`STOP: unexpected error: ${(e as Error).message}`); process.exit(2); });
}
