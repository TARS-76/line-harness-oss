import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPreflight } from '../../src/phases/preflight.js';
import { createEventEmitter } from '../../src/events.js';
import type {
  UpdateContext,
  UpdateEvent,
  ReleaseEntry,
  CurrentVersion,
  CfApiCreds,
} from '../../src/types.js';

const ACCOUNT_ID = 'acct123';
const API_TOKEN = 'tok_abc';
const WORKER_NAME = 'your-worker-name';
const ADMIN_PROJECT = 'your-admin-name';
const LIFF_PROJECT = 'line-crm-liff';
const D1_ID = 'db_xyz';

const creds: CfApiCreds = {
  accountId: ACCOUNT_ID,
  apiToken: API_TOKEN,
};

const sampleRelease = (overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version: '0.7.0',
  released_at: '2026-05-01T00:00:00Z',
  worker_hash: 'sha256:worker',
  admin_hash: 'sha256:admin',
  liff_hash: 'sha256:liff',
  bundle_url: 'https://example.com/bundles/0.7.0.tar.gz',
  bundle_size_bytes: 12345,
  required_secrets: [],
  new_required_secrets: [],
  migrations: [],
  changelog_url: 'https://example.com/changelog#0.7.0',
  min_from_version: '0.6.0',
  ...overrides,
});

const sampleCurrent = (version = '0.6.0'): CurrentVersion => ({
  version,
  worker_hash: 'sha256:worker-current',
  admin_hash: 'sha256:admin-current',
  liff_hash: 'sha256:liff-current',
});

const sampleCtx = (overrides: Partial<UpdateContext> = {}): UpdateContext => ({
  creds,
  workerName: WORKER_NAME,
  adminPagesProject: ADMIN_PROJECT,
  liffPagesProject: LIFF_PROJECT,
  d1DatabaseId: D1_ID,
  current: sampleCurrent(),
  target: sampleRelease(),
  manifestUrl: 'https://example.com/manifest.json',
  ...overrides,
});

/**
 * Build a fetch mock that routes by URL substring. Each entry returns a
 * Response-shaped object (only the fields preflight inspects: ok + status,
 * plus a json() callback for completeness).
 */
function makeRouter(
  routes: Record<string, { ok: boolean; status: number; body?: unknown }>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    for (const [key, resp] of Object.entries(routes)) {
      if (url.includes(key)) {
        return {
          ok: resp.ok,
          status: resp.status,
          json: async () => resp.body ?? {},
          text: async () =>
            resp.body === undefined ? '' : JSON.stringify(resp.body),
        } as unknown as Response;
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  }) as unknown as ReturnType<typeof vi.fn>;
}

function collectEvents(): {
  events: UpdateEvent[];
  emitter: ReturnType<typeof createEventEmitter>;
} {
  const events: UpdateEvent[] = [];
  const emitter = createEventEmitter({
    persist: async (e) => {
      events.push(e);
    },
  });
  return { events, emitter };
}

describe('runPreflight', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('happy path — all checks pass, emits running then done', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200, body: { result: { status: 'active' } } },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: true, status: 200 },
      [`/pages/projects/${ADMIN_PROJECT}`]: { ok: true, status: 200 },
      [`/pages/projects/${LIFF_PROJECT}`]: { ok: true, status: 200 },
      [`/d1/database/${D1_ID}/query`]: {
        ok: true,
        status: 200,
        body: { success: true, result: [{ results: [{ '1': 1 }] }] },
      },
    }) as unknown as typeof fetch;

    const { events, emitter } = collectEvents();
    await runPreflight(sampleCtx(), emitter);

    expect(events[0]).toEqual({ step: 'preflight', status: 'running' });
    expect(events[events.length - 1]).toEqual({
      step: 'preflight',
      status: 'done',
    });
  });

  it('throws when min_from_version not satisfied', async () => {
    // Don't need fetch mocks because we should throw before any HTTP call.
    const ctx = sampleCtx({
      current: sampleCurrent('0.5.0'),
      target: sampleRelease({ min_from_version: '0.6.0' }),
    });

    const { events, emitter } = collectEvents();
    await expect(runPreflight(ctx, emitter)).rejects.toThrow(
      /min_from_version 0\.6\.0 not satisfied.*0\.5\.0/,
    );

    // running emitted, but not done
    expect(events.some((e) => e.status === 'running')).toBe(true);
    expect(events.some((e) => e.status === 'done')).toBe(false);
  });

  it('throws when token verify returns 403', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: false, status: 403, body: { errors: [{ message: 'invalid token' }] } },
    }) as unknown as typeof fetch;

    const { events, emitter } = collectEvents();
    await expect(runPreflight(sampleCtx(), emitter)).rejects.toThrow(
      /token verify failed.*403/i,
    );

    expect(events.some((e) => e.status === 'running')).toBe(true);
    expect(events.some((e) => e.status === 'done')).toBe(false);
  });

  it('throws when Worker is missing (404), message includes worker name', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200 },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: false, status: 404 },
    }) as unknown as typeof fetch;

    const { events, emitter } = collectEvents();
    await expect(runPreflight(sampleCtx(), emitter)).rejects.toThrow(
      new RegExp(WORKER_NAME),
    );

    expect(events.some((e) => e.status === 'running')).toBe(true);
    expect(events.some((e) => e.status === 'done')).toBe(false);
  });

  it('throws when admin Pages project is missing', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200 },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: true, status: 200 },
      [`/pages/projects/${ADMIN_PROJECT}`]: { ok: false, status: 404 },
    }) as unknown as typeof fetch;

    const { events, emitter } = collectEvents();
    await expect(runPreflight(sampleCtx(), emitter)).rejects.toThrow(
      new RegExp(ADMIN_PROJECT),
    );

    expect(events.some((e) => e.status === 'done')).toBe(false);
  });

  it('throws when LIFF Pages project is missing', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200 },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: true, status: 200 },
      [`/pages/projects/${ADMIN_PROJECT}`]: { ok: true, status: 200 },
      [`/pages/projects/${LIFF_PROJECT}`]: { ok: false, status: 404 },
    }) as unknown as typeof fetch;

    const { events, emitter } = collectEvents();
    await expect(runPreflight(sampleCtx(), emitter)).rejects.toThrow(
      new RegExp(LIFF_PROJECT),
    );

    expect(events.some((e) => e.status === 'done')).toBe(false);
  });

  it('throws when D1 is unreachable, error mentions D1 id', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200 },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: true, status: 200 },
      [`/pages/projects/${ADMIN_PROJECT}`]: { ok: true, status: 200 },
      [`/pages/projects/${LIFF_PROJECT}`]: { ok: true, status: 200 },
      [`/d1/database/${D1_ID}/query`]: { ok: false, status: 500, body: { errors: [{ message: 'down' }] } },
    }) as unknown as typeof fetch;

    const { events, emitter } = collectEvents();
    await expect(runPreflight(sampleCtx(), emitter)).rejects.toThrow(
      new RegExp(D1_ID),
    );

    expect(events.some((e) => e.status === 'done')).toBe(false);
  });

  it('emits informational requires_secrets event when new_required_secrets are present', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200 },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: true, status: 200 },
      [`/pages/projects/${ADMIN_PROJECT}`]: { ok: true, status: 200 },
      [`/pages/projects/${LIFF_PROJECT}`]: { ok: true, status: 200 },
      [`/d1/database/${D1_ID}/query`]: {
        ok: true,
        status: 200,
        body: { success: true, result: [{ results: [{ '1': 1 }] }] },
      },
    }) as unknown as typeof fetch;

    const ctx = sampleCtx({
      target: sampleRelease({
        new_required_secrets: ['STRIPE_KEY', 'OPENAI_KEY'],
      }),
    });

    const { events, emitter } = collectEvents();
    await runPreflight(ctx, emitter);

    const requiresEvent = events.find(
      (e) =>
        e.step === 'preflight' &&
        e.status === 'running' &&
        e.name?.startsWith('requires_secrets:'),
    );
    expect(requiresEvent).toBeDefined();
    expect(requiresEvent!.name).toBe('requires_secrets:STRIPE_KEY,OPENAI_KEY');

    // still emits "done" at the end
    expect(events[events.length - 1]).toEqual({
      step: 'preflight',
      status: 'done',
    });
  });

  it('does NOT emit requires_secrets event when new_required_secrets is empty', async () => {
    globalThis.fetch = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200 },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: true, status: 200 },
      [`/pages/projects/${ADMIN_PROJECT}`]: { ok: true, status: 200 },
      [`/pages/projects/${LIFF_PROJECT}`]: { ok: true, status: 200 },
      [`/d1/database/${D1_ID}/query`]: {
        ok: true,
        status: 200,
        body: { success: true, result: [{ results: [{ '1': 1 }] }] },
      },
    }) as unknown as typeof fetch;

    const { events, emitter } = collectEvents();
    await runPreflight(sampleCtx(), emitter);

    const requiresEvent = events.find((e) =>
      e.name?.startsWith('requires_secrets:'),
    );
    expect(requiresEvent).toBeUndefined();
  });

  it('uses Bearer auth on all CF calls and correct URLs', async () => {
    const fetchMock = makeRouter({
      '/user/tokens/verify': { ok: true, status: 200 },
      [`/workers/scripts/${WORKER_NAME}`]: { ok: true, status: 200 },
      [`/pages/projects/${ADMIN_PROJECT}`]: { ok: true, status: 200 },
      [`/pages/projects/${LIFF_PROJECT}`]: { ok: true, status: 200 },
      [`/d1/database/${D1_ID}/query`]: {
        ok: true,
        status: 200,
        body: { success: true, result: [{ results: [{ '1': 1 }] }] },
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { emitter } = collectEvents();
    await runPreflight(sampleCtx(), emitter);

    // First call must be the token verify with Bearer auth.
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(verifyUrl).toBe(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
    );
    const headers = verifyInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_TOKEN}`);
  });
});
