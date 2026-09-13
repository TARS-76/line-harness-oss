import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db so we can assert on the values the route forwards to the
// DB layer without needing a real D1Database. The route's responsibility is
// "normalize body → call DB function with correct args", so capturing those
// args is the meaningful assertion.
const dbMocks = {
  getLineAccounts: vi.fn(),
  getLineAccountById: vi.fn(),
  createLineAccount: vi.fn(),
  updateLineAccount: vi.fn(),
  updateLineAccountFields: vi.fn(),
  updateLineAccountOrder: vi.fn(),
  deleteLineAccount: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

// Re-import after mock so the module picks up mocked deps.
const { lineAccounts } = await import('./line-accounts.js');

type TestEnv = {
  Variables: { staff: { id: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: { DB: D1Database };
};

// Minimal D1 stub: every prepare/bind/first chain resolves to `null` (no row).
// Used for the uniqueness check in checkUniqueLoginAndLiff — tests that need
// to assert duplicate-rejection override `firstResult` per request.
function makeDbStub(firstResult: unknown = null): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(firstResult),
      })),
    })),
  } as unknown as D1Database;
}

function setupApp(
  role: 'owner' | 'admin' | 'staff' = 'owner',
  dbStub: D1Database = makeDbStub(),
) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = { DB: dbStub };
    await next();
  });
  app.route('/', lineAccounts);
  return app;
}

const fakeAccount = {
  id: 'acc-1',
  channel_id: '123456789',
  name: 'メイン',
  channel_access_token: 'token',
  channel_secret: 'secret',
  login_channel_id: null,
  login_channel_secret: null,
  liff_id: null,
  is_active: 1,
  country: null,
  role: null,
  display_order: 0,
  token_expires_at: null,
  created_at: '2026-05-08T00:00:00.000',
  updated_at: '2026-05-08T00:00:00.000',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('POST /api/line-accounts', () => {
  test('passes loginChannelId / loginChannelSecret / liffId through to createLineAccount', async () => {
    dbMocks.createLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'login-secret',
      liff_id: '2009624792-XXXX',
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-XXXX',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createLineAccount).toHaveBeenCalledTimes(1);
    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      channelId: '123456789',
      loginChannelId: '2009624792',
      loginChannelSecret: 'login-secret',
      liffId: '2009624792-XXXX',
    });

    const body = (await res.json()) as { success: boolean; data: { loginChannelId: string | null; liffId: string | null; loginChannelSecret: string | null } };
    expect(body.success).toBe(true);
    expect(body.data.loginChannelId).toBe('2009624792');
    expect(body.data.liffId).toBe('2009624792-XXXX');
    // serializeLineAccountFull exposes loginChannelSecret to owner-only POST response
    expect(body.data.loginChannelSecret).toBe('login-secret');
  });

  test('omits loginChannelId/etc when not provided (stores null)', async () => {
    dbMocks.createLineAccount.mockResolvedValue(fakeAccount);

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      loginChannelId: null,
      loginChannelSecret: null,
      liffId: null,
    });
  });

  test('trims whitespace and treats empty string as null for optional fields', async () => {
    dbMocks.createLineAccount.mockResolvedValue(fakeAccount);

    // Use a complete login pair (both id+secret present) to focus on the
    // trim/empty-string normalization behavior. liffId is independent.
    const app = setupApp('owner');
    await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '  2009624792  ',
        loginChannelSecret: '  login-secret  ',
        liffId: '   ',
      }),
    });

    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      loginChannelId: '2009624792',
      loginChannelSecret: 'login-secret',
      liffId: null,
    });
  });
});

describe('PATCH /api/line-accounts/:id', () => {
  test('updates loginChannelId / loginChannelSecret / liffId via metadata path', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      liff_id: '2009999999-YYYY',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009999999',
        loginChannelSecret: 'rotated',
        liffId: '2009999999-YYYY',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      loginChannelId: '2009999999',
      loginChannelSecret: 'rotated',
      liffId: '2009999999-YYYY',
    });
  });

  test('clears LIFF when explicitly set to empty string', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      liff_id: null,
    });

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '' }),
    });

    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      liffId: null,
    });
  });

  test('does not touch login/liff fields when not provided', async () => {
    dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: '日本' }),
    });

    const arg = dbMocks.updateLineAccountFields.mock.calls[0][2];
    expect(arg.country).toBe('日本');
    expect(arg.loginChannelId).toBeUndefined();
    expect(arg.loginChannelSecret).toBeUndefined();
    expect(arg.liffId).toBeUndefined();
  });
});

describe('Login pair / uniqueness validation', () => {
  test('POST: rejects loginChannelId without secret', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        // loginChannelSecret missing
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/loginChannelSecret/);
  });

  test('POST: rejects loginChannelSecret without ID', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelSecret: 'orphan',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('POST: rejects duplicate liffId', async () => {
    // makeDbStub returns "another row already has this liff_id"
    const app = setupApp('owner', makeDbStub({ id: 'other-acc' }));

    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        liffId: '2009624792-DUPLICATE',
      }),
    });

    expect(res.status).toBe(409);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/already assigned/);
  });

  test('PATCH: LIFF-only edit succeeds against half-configured Login (id-only) account', async () => {
    // Setup CLI persists login_channel_id without secret as a best-effort.
    // Adding a LIFF ID later via the dashboard must NOT trip the pair check
    // because the request doesn't touch the Login fields at all.
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
      liff_id: '2009624792-NEW',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '2009624792-NEW' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      liffId: '2009624792-NEW',
    });
  });

  test('PATCH: clearing both Login fields together succeeds', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: null,
      login_channel_secret: null,
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null, loginChannelSecret: null }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      loginChannelId: null,
      loginChannelSecret: null,
    });
  });

  test('PATCH: clearing only loginChannelId is rejected (would orphan the secret)', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });

  test('PATCH: keeps existing secret when only changing the loginChannelId', async () => {
    // Current row already has both id+secret. Caller changes only the id —
    // pair check should pass because the unchanged secret keeps the pair complete.
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'kept-secret',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'new-id',
      login_channel_secret: 'kept-secret',
    });

    const app = setupApp('admin');

    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: 'new-id' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields).toHaveBeenCalled();
  });
});

describe('PUT /api/line-accounts/:id', () => {
  test('owner can update Login/LIFF + country/role in one request', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_secret: 'existing-secret',
    });
    dbMocks.updateLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'existing-secret',
      liff_id: '2009624792-XXXX',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'existing-secret',
      liff_id: '2009624792-XXXX',
      country: '日本',
      role: '本店',
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009624792',
        liffId: '2009624792-XXXX',
        country: '日本',
        role: '本店',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccount.mock.calls[0][2]).toMatchObject({
      login_channel_id: '2009624792',
      liff_id: '2009624792-XXXX',
    });
    // country/role uses the fields helper (separate code path)
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      country: '日本',
      role: '本店',
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/line-accounts — messagesThisMonth の月初境界
//
// WHY: 「今月送信」は LINE 無料プラン 200 通/月クォータのゲージなので、月の
// 切り替わりを1秒でも取り違えると前月分が混入して「使い切った」ように見える。
// 以前は SQL 側で date('now','start of month') を使っていたため、SQLite が UTC
// 基準で当月初日を出し、毎月1日の 00:00-09:00 JST の9時間だけ境界が前月1日に
// なっていた。ここで固定するのは「now が何時であっても境界は当月1日 00:00 JST」
// という不変条件。
// ---------------------------------------------------------------------------

/**
 * prepare/bind を記録する D1 スタブ。stats 系クエリはすべて {count} を返す。
 * 「どんなSQLを組んだか」ではなく「境界値をいくつ渡したか」を見たいので、
 * bind 引数を拾う。
 */
function makeStatsDbStub() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return { first: vi.fn().mockResolvedValue({ count: 0 }) };
      }),
    })),
  } as unknown as D1Database;
  return { db, calls };
}

/** messages_log のクエリに渡された当月開始境界を取り出す。 */
function monthStartBoundary(calls: { sql: string; args: unknown[] }[]): unknown {
  const call = calls.find((x) => x.sql.includes('FROM messages_log'));
  if (!call) throw new Error('messages_log のクエリが発行されていない');
  // account id 以外のバインド値が境界。修正前は境界を渡していないので undefined。
  return call.args.find((a) => a !== fakeAccount.id);
}

/** SQL の文字列比較と同じ判定。境界以上なら「今月」に数えられる。 */
function isCountedAsThisMonth(createdAt: string, boundary: unknown): boolean {
  return createdAt >= String(boundary);
}

async function fetchAccountsAt(isoUtcNow: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoUtcNow));
  try {
    dbMocks.getLineAccounts.mockResolvedValue([fakeAccount]);
    const { db, calls } = makeStatsDbStub();
    const app = setupApp('owner', db);
    const res = await app.request('/api/line-accounts');
    return { res, calls };
  } finally {
    vi.useRealTimers();
  }
}

describe('GET /api/line-accounts — messagesThisMonth の月初境界', () => {
  beforeEach(() => {
    // fetchBotProfile が api.line.me を叩くのを止める（LINE へ到達させない）。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  test('月初 00:30 JST（前日 15:30 UTC）でも境界は当月1日で、前月の push を数えない', async () => {
    // 2026-09-30T15:30:00Z === 2026-10-01 00:30 JST
    const { res, calls } = await fetchAccountsAt('2026-09-30T15:30:00.000Z');
    expect(res.status).toBe(200);

    const boundary = monthStartBoundary(calls);
    expect(boundary).toBe('2026-10-01T00:00:00.000+09:00');

    // 前月分は数えない — これが混入していたのが本バグ
    expect(isCountedAsThisMonth('2026-09-15T12:00:00.000+09:00', boundary)).toBe(false);
    expect(isCountedAsThisMonth('2026-09-30T23:30:00.000+09:00', boundary)).toBe(false);
    // 当月分（now の直前に送ったもの）は数える
    expect(isCountedAsThisMonth('2026-10-01T00:29:00.000+09:00', boundary)).toBe(true);
  });

  test('月初 09:30 JST（従来も正しかった時間帯）で挙動が変わらない', async () => {
    // 2026-10-01T00:30:00Z === 2026-10-01 09:30 JST
    const { res, calls } = await fetchAccountsAt('2026-10-01T00:30:00.000Z');
    expect(res.status).toBe(200);

    const boundary = monthStartBoundary(calls);
    expect(boundary).toBe('2026-10-01T00:00:00.000+09:00');
    expect(isCountedAsThisMonth('2026-09-30T23:30:00.000+09:00', boundary)).toBe(false);
    expect(isCountedAsThisMonth('2026-10-01T00:30:00.000+09:00', boundary)).toBe(true);
  });

  test('月末 23:30 JST の push が当月に数えられる', async () => {
    // 2026-10-31T14:30:00Z === 2026-10-31 23:30 JST
    const { res, calls } = await fetchAccountsAt('2026-10-31T14:30:00.000Z');
    expect(res.status).toBe(200);

    const boundary = monthStartBoundary(calls);
    expect(boundary).toBe('2026-10-01T00:00:00.000+09:00');
    expect(isCountedAsThisMonth('2026-10-31T23:30:00.000+09:00', boundary)).toBe(true);
  });

  test('SQL 側に UTC 基準の now を残さない', async () => {
    const { calls } = await fetchAccountsAt('2026-09-30T15:30:00.000Z');
    const sql = calls.find((x) => x.sql.includes('FROM messages_log'))!.sql;
    expect(sql).not.toContain("date('now'");
    expect(sql).not.toContain("'now'");
  });
});
