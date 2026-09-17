import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MCP_EXAMPLE_PATH,
  MCP_LOCAL_PATH,
  PERMISSION_PREFIX,
  checkMcpServers,
  extractToolNames,
  reconcile,
  selectConfigFiles,
  splitPermissionEntries,
} from './check-mcp-permissions';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-mcp-permissions.ts');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const harnessServer = {
  command: 'node',
  args: ['./packages/mcp-server/dist/index.js'],
  env: { LINE_HARNESS_API_URL: 'http://127.0.0.1:8788', LINE_HARNESS_API_KEY: 'lh_x' },
};

describe('reconcile', () => {
  // A tool in neither list falls through to an interactive prompt, which in an
  // unattended session means it is reachable. That must fail, not pass.
  it('flags a registered tool that is in neither allow nor deny', () => {
    const result = reconcile({
      registered: ['list_friends', 'send_message'],
      allow: ['list_friends'],
      deny: [],
    });
    expect(result.uncovered).toEqual(['send_message']);
  });

  // A stale entry makes the deny list look bigger than the protection it buys.
  it('flags a listed tool that is no longer registered', () => {
    const result = reconcile({
      registered: ['list_friends'],
      allow: ['list_friends'],
      deny: ['removed_tool'],
    });
    expect(result.stale).toEqual(['removed_tool']);
  });

  // deny wins at runtime, but the contradiction hides intent from the reader.
  it('flags a tool listed in both allow and deny', () => {
    const result = reconcile({
      registered: ['broadcast'],
      allow: ['broadcast'],
      deny: ['broadcast'],
    });
    expect(result.conflicting).toEqual(['broadcast']);
  });

  it('passes when every registered tool is covered exactly once', () => {
    const result = reconcile({
      registered: ['list_friends', 'send_message'],
      allow: ['list_friends'],
      deny: ['send_message'],
    });
    expect(result).toEqual({ uncovered: [], stale: [], conflicting: [] });
  });
});

describe('extractToolNames', () => {
  it('reads the name from a server.tool() registration', () => {
    const src = `server.tool(\n  "account_summary",\n  "Summarise an account",\n  {},\n);`;
    expect(extractToolNames(src)).toEqual(['account_summary']);
  });

  // Helper modules (e.g. auto-track-urls.ts) register nothing and must not be
  // mistaken for tools.
  it('returns nothing for a module with no registration', () => {
    expect(extractToolNames(`export async function autoTrackUrls() {}`)).toEqual([]);
  });
});

// (a) The permission keys embed the server name, so the key must be exactly
// `line-harness`. Any other key pointing at our server is a silent bypass.
describe('checkMcpServers (a: server name is fixed)', () => {
  it('passes when mcpServers has the line-harness key', () => {
    expect(checkMcpServers({ mcpServers: { 'line-harness': harnessServer } })).toEqual([]);
  });

  it('fails when the line-harness key is missing', () => {
    const problems = checkMcpServers({ mcpServers: { 'line-harness-miki': harnessServer } });
    expect(problems.some((p) => p.includes('mcpServers.line-harness is missing'))).toBe(true);
  });

  it('fails on an alias key that points at packages/mcp-server, even next to the real one', () => {
    const problems = checkMcpServers({
      mcpServers: { 'line-harness': harnessServer, 'line-harness-miki': harnessServer },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/mcpServers\.line-harness-miki is an alias/);
  });

  // Other MCP servers (playwright, etc.) legitimately live in the same file.
  it('ignores unrelated servers', () => {
    const problems = checkMcpServers({
      mcpServers: {
        'line-harness': harnessServer,
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
      },
    });
    expect(problems).toEqual([]);
  });

  it('fails when mcpServers is absent', () => {
    expect(checkMcpServers({})).toEqual(['mcpServers is missing or not an object']);
  });
});

// (b)/(c) Which files each mode must inspect. CI never has .mcp.json (it is
// gitignored); a developer machine must, or the client is not wired up.
describe('selectConfigFiles (b: --ci / c: local)', () => {
  it('--ci inspects only .mcp.json.example and does not require .mcp.json', () => {
    const exists = (p: string) => p === MCP_EXAMPLE_PATH;
    expect(selectConfigFiles('ci', exists)).toEqual({ files: [MCP_EXAMPLE_PATH], missing: [] });
  });

  it('local inspects both files', () => {
    const exists = () => true;
    expect(selectConfigFiles('local', exists)).toEqual({
      files: [MCP_EXAMPLE_PATH, MCP_LOCAL_PATH],
      missing: [],
    });
  });

  it('local reports a missing .mcp.json instead of skipping it', () => {
    const exists = (p: string) => p === MCP_EXAMPLE_PATH;
    expect(selectConfigFiles('local', exists)).toEqual({
      files: [MCP_EXAMPLE_PATH],
      missing: [MCP_LOCAL_PATH],
    });
  });
});

// (d) An entry under a different harness prefix would previously be filtered
// out without a trace — which is the exact drift this script guards against.
describe('splitPermissionEntries (d: mismatched prefix is surfaced)', () => {
  it('keeps line-harness entries and surfaces other harness prefixes', () => {
    const result = splitPermissionEntries([
      `${PERMISSION_PREFIX}broadcast`,
      'mcp__line-harness-miki__broadcast',
      'mcp__harness__send_message',
    ]);
    expect(result.tools).toEqual(['broadcast']);
    expect(result.ignoredHarness).toEqual([
      'mcp__line-harness-miki__broadcast',
      'mcp__harness__send_message',
    ]);
  });

  it('silently ignores non-harness entries', () => {
    const result = splitPermissionEntries(['Bash(git:*)', 'mcp__playwright__browser_click']);
    expect(result).toEqual({ tools: [], ignoredHarness: [] });
  });
});

// End-to-end through the CLI, in a scratch repo, so the mode switch and exit
// codes are exercised for real rather than through the helpers alone.
describe('CLI modes (b/c/d end-to-end)', () => {
  function scaffold(opts: { withLocal: boolean; extraDeny?: string[] }): string {
    const root = mkdtempSync(join(tmpdir(), 'check-mcp-'));
    mkdirSync(join(root, 'packages/mcp-server/src/tools'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, 'packages/mcp-server/src/tools/list-friends.ts'),
      `server.tool("list_friends", "x", {});`,
    );
    writeFileSync(
      join(root, 'packages/mcp-server/src/tools/broadcast.ts'),
      `server.tool("broadcast", "x", {});`,
    );
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        permissions: {
          allow: [`${PERMISSION_PREFIX}list_friends`],
          deny: [`${PERMISSION_PREFIX}broadcast`, ...(opts.extraDeny ?? [])],
        },
      }),
    );
    const cfg = JSON.stringify({ mcpServers: { 'line-harness': harnessServer } });
    writeFileSync(join(root, MCP_EXAMPLE_PATH), cfg);
    if (opts.withLocal) writeFileSync(join(root, MCP_LOCAL_PATH), cfg);
    return root;
  }

  function run(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(TSX, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  }

  it('--ci passes without .mcp.json', () => {
    const r = run(scaffold({ withLocal: false }), ['--ci']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^OK — 2 tools/);
    expect(r.stdout).toContain('(ci mode)');
  });

  it('local mode fails without .mcp.json', () => {
    const r = run(scaffold({ withLocal: false }), []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`[FAIL] missing: ${MCP_LOCAL_PATH} not found`);
  });

  it('local mode passes when both files exist', () => {
    const r = run(scaffold({ withLocal: true }), []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${MCP_EXAMPLE_PATH}, ${MCP_LOCAL_PATH} (local mode)`);
  });

  // A deny under the wrong prefix protects nothing; passing would hide that.
  it('fails on a mismatched harness prefix', () => {
    const r = run(scaffold({ withLocal: true, extraDeny: ['mcp__line-harness-miki__broadcast'] }), []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('[FAIL] prefix: mcp__line-harness-miki__broadcast');
  });
});
