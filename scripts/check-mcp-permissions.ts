#!/usr/bin/env tsx
/**
 * MCP permission reconciliation.
 *
 * `.claude/settings.json` gates every MCP tool the harness exposes: read-only
 * tools go in `permissions.allow`, write/side-effecting tools in
 * `permissions.deny`. A tool that appears in neither list falls through to an
 * interactive prompt — which in an unattended session silently means the tool
 * is reachable. This script makes that drift fail loudly instead.
 *
 * Permission entries embed the MCP server name (`mcp__<server>__<tool>`), so
 * the server key in `.mcp.json` must be exactly `line-harness`. A renamed or
 * aliased key would leave every deny entry unmatched and — with no error —
 * open every write tool. That is checked here too.
 *
 * Checks:
 *   - server:    `mcpServers.line-harness` exists in each MCP config file, and
 *                no other key points at packages/mcp-server (an alias)
 *   - uncovered: registered but in neither allow nor deny
 *   - stale:     listed in settings.json but no longer registered
 *   - conflict:  listed in both allow and deny
 *   - prefix:    a `mcp__*harness*__` entry whose prefix is not
 *                `mcp__line-harness__` — it matches nothing at runtime, so
 *                a deny written that way is a silent no-op. Fails.
 *
 * Library API:
 *   checkMcpServers(config)                    → string[] problems
 *   selectConfigFiles(mode, exists)            → { files, missing }
 *   splitPermissionEntries(list)               → { tools, ignoredHarness }
 *   reconcile({ registered, allow, deny })     → { uncovered, stale, conflicting }
 *
 * CLI:
 *   tsx scripts/check-mcp-permissions.ts [--ci]
 *
 * - default (local): checks `.mcp.json.example` AND `.mcp.json`. A missing
 *   `.mcp.json` is a failure — it means the local client is not wired up.
 * - `--ci`: checks `.mcp.json.example` only (`.mcp.json` is gitignored and
 *   never present in CI).
 * - Prints "[FAIL] <kind>: ..." per problem, exit 1
 * - Prints "OK — N tools, all covered." on success
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit, stderr, stdout } from 'node:process';

const TOOLS_DIR = 'packages/mcp-server/src/tools';
const SETTINGS_PATH = '.claude/settings.json';
export const MCP_EXAMPLE_PATH = '.mcp.json.example';
export const MCP_LOCAL_PATH = '.mcp.json';

/** The one server name the permission entries are written against. */
export const SERVER_NAME = 'line-harness';
export const PERMISSION_PREFIX = `mcp__${SERVER_NAME}__`;

/** Anything whose command/args mention this path is our MCP server. */
const MCP_SERVER_PATH_MARK = 'packages/mcp-server';

export type Mode = 'ci' | 'local';

export interface ReconcileInput {
  registered: string[];
  allow: string[];
  deny: string[];
}

export interface ReconcileResult {
  uncovered: string[];
  stale: string[];
  conflicting: string[];
}

export function reconcile({ registered, allow, deny }: ReconcileInput): ReconcileResult {
  const allowSet = new Set(allow);
  const denySet = new Set(deny);
  const registeredSet = new Set(registered);
  const listed = [...new Set([...allow, ...deny])];

  return {
    uncovered: registered.filter((t) => !allowSet.has(t) && !denySet.has(t)).sort(),
    stale: listed.filter((t) => !registeredSet.has(t)).sort(),
    conflicting: allow.filter((t) => denySet.has(t)).sort(),
  };
}

/**
 * Each tool file calls `server.tool("<name>", ...)` exactly once. Parsing the
 * source rather than importing the built server keeps this runnable without a
 * build step (and without MCP transport side effects).
 */
export function extractToolNames(source: string): string[] {
  const names: string[] = [];
  const re = /server\.tool\(\s*["']([a-z0-9_]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

function pointsAtHarnessServer(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  const parts = [command, ...(Array.isArray(args) ? args : [])];
  return parts.some((p) => typeof p === 'string' && p.includes(MCP_SERVER_PATH_MARK));
}

/**
 * Validate the `mcpServers` block of one MCP config file. Returns a list of
 * human-readable problems; empty means OK.
 */
export function checkMcpServers(config: unknown): string[] {
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return ['mcpServers is missing or not an object'];
  }
  const problems: string[] = [];
  const entries = servers as Record<string, unknown>;

  if (!(SERVER_NAME in entries)) {
    problems.push(
      `mcpServers.${SERVER_NAME} is missing — permission entries are keyed ${PERMISSION_PREFIX}* and will match nothing`,
    );
  }
  for (const [key, entry] of Object.entries(entries)) {
    if (key === SERVER_NAME) continue;
    if (pointsAtHarnessServer(entry)) {
      problems.push(
        `mcpServers.${key} is an alias of ${MCP_SERVER_PATH_MARK} — the server name is fixed to "${SERVER_NAME}"; deny entries would not match mcp__${key}__*`,
      );
    }
  }
  return problems;
}

/**
 * Which MCP config files a run must inspect. `missing` are files the mode
 * requires but which do not exist — each is a failure, not a skip.
 */
export function selectConfigFiles(
  mode: Mode,
  exists: (path: string) => boolean,
): { files: string[]; missing: string[] } {
  const wanted = mode === 'ci' ? [MCP_EXAMPLE_PATH] : [MCP_EXAMPLE_PATH, MCP_LOCAL_PATH];
  return {
    files: wanted.filter(exists),
    missing: wanted.filter((p) => !exists(p)),
  };
}

/**
 * Strip the permission prefix from tool entries. Entries that look like they
 * target a harness MCP server but under a different prefix are returned in
 * `ignoredHarness` so the caller can fail — they would otherwise be dropped
 * silently, which is exactly the failure mode this script exists to catch.
 * Non-MCP entries (e.g. `Bash(git:*)`) and unrelated MCP servers are ignored.
 */
export function splitPermissionEntries(list: string[]): {
  tools: string[];
  ignoredHarness: string[];
} {
  const tools: string[] = [];
  const ignoredHarness: string[] = [];
  const otherHarnessPrefix = /^mcp__[^_]*harness[^_]*__/;
  for (const e of list) {
    if (e.startsWith(PERMISSION_PREFIX)) {
      tools.push(e.slice(PERMISSION_PREFIX.length));
    } else if (otherHarnessPrefix.test(e)) {
      ignoredHarness.push(e);
    }
  }
  return { tools, ignoredHarness };
}

function readRegisteredTools(): string[] {
  const dir = resolve(TOOLS_DIR);
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .flatMap((f) => extractToolNames(readFileSync(join(dir, f), 'utf8')));
  return [...new Set(names)].sort();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

function main(args: string[]): void {
  const mode: Mode = args.includes('--ci') ? 'ci' : 'local';
  let failures = 0;

  // 1) Server name in every MCP config the mode requires.
  const { files, missing } = selectConfigFiles(mode, (p) => existsSync(resolve(p)));
  for (const f of missing) {
    const hint =
      f === MCP_LOCAL_PATH ? ` (copy ${MCP_EXAMPLE_PATH} to ${MCP_LOCAL_PATH}, or run with --ci)` : '';
    stdout.write(`[FAIL] missing: ${f} not found${hint}\n`);
    failures++;
  }
  for (const f of files) {
    for (const p of checkMcpServers(readJson(f))) {
      stdout.write(`[FAIL] server: ${f}: ${p}\n`);
      failures++;
    }
  }

  // 2) Tool coverage in settings.json.
  const registered = readRegisteredTools();
  if (registered.length === 0) {
    stderr.write(`check-mcp-permissions: no tools found under ${TOOLS_DIR}\n`);
    exit(1);
  }

  const parsed = readJson(SETTINGS_PATH) as {
    permissions?: { allow?: string[]; deny?: string[] };
  };
  const allowSplit = splitPermissionEntries(parsed.permissions?.allow ?? []);
  const denySplit = splitPermissionEntries(parsed.permissions?.deny ?? []);
  for (const e of [...allowSplit.ignoredHarness, ...denySplit.ignoredHarness]) {
    stdout.write(
      `[FAIL] prefix: ${e} does not use prefix ${PERMISSION_PREFIX} and will never match a registered tool\n`,
    );
    failures++;
  }

  const { uncovered, stale, conflicting } = reconcile({
    registered,
    allow: allowSplit.tools,
    deny: denySplit.tools,
  });
  for (const t of uncovered) {
    stdout.write(`[FAIL] uncovered: ${PERMISSION_PREFIX}${t} is registered but in neither allow nor deny\n`);
  }
  for (const t of stale) {
    stdout.write(`[FAIL] stale: ${PERMISSION_PREFIX}${t} is listed but no longer registered\n`);
  }
  for (const t of conflicting) {
    stdout.write(`[FAIL] conflict: ${PERMISSION_PREFIX}${t} is in both allow and deny\n`);
  }
  failures += uncovered.length + stale.length + conflicting.length;

  if (failures > 0) {
    stdout.write(`\n${failures} problem(s) found (${mode} mode, ${registered.length} registered tools).\n`);
    exit(1);
  }

  stdout.write(
    `OK — ${registered.length} tools, all covered (${allowSplit.tools.length} allow / ${denySplit.tools.length} deny); server "${SERVER_NAME}" present in ${files.join(', ')} (${mode} mode).\n`,
  );
}

const isCliEntry = (() => {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  try {
    main(argv.slice(2));
  } catch (err) {
    stderr.write(`check-mcp-permissions: ${(err as Error).message}\n`);
    exit(1);
  }
}
