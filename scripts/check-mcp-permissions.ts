#!/usr/bin/env tsx
/**
 * MCP tool-name reconciliation.
 *
 * `.claude/settings.json` gates every MCP tool the harness exposes: read-only
 * tools go in `permissions.allow`, write/side-effecting tools in
 * `permissions.deny`. A tool that appears in neither list falls through to an
 * interactive prompt — which in an unattended session silently means the tool
 * is reachable. This script makes that drift fail loudly instead.
 *
 * Checks, against the tools actually registered in packages/mcp-server:
 *   - uncovered: registered but in neither allow nor deny
 *   - stale:     listed in settings.json but no longer registered
 *   - conflict:  listed in both allow and deny
 *
 * Library API:
 *   reconcile({ registered, allow, deny }) → { uncovered, stale, conflicting }
 *
 * CLI:
 *   tsx scripts/check-mcp-permissions.ts
 *
 * - Prints "[FAIL] <kind>: <tool>" per problem, exit 1
 * - Prints "OK — N tools, all covered." on success
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit, stderr, stdout } from 'node:process';

const TOOLS_DIR = 'packages/mcp-server/src/tools';
const SETTINGS_PATH = '.claude/settings.json';

/** Permission entries are namespaced by the MCP server name from .mcp.json. */
export const PERMISSION_PREFIX = 'mcp__line-harness__';

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

function readRegisteredTools(): string[] {
  const dir = resolve(TOOLS_DIR);
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .flatMap((f) => extractToolNames(readFileSync(join(dir, f), 'utf8')));
  return [...new Set(names)].sort();
}

function readPermissions(): { allow: string[]; deny: string[] } {
  const raw = readFileSync(resolve(SETTINGS_PATH), 'utf8');
  const parsed = JSON.parse(raw) as {
    permissions?: { allow?: string[]; deny?: string[] };
  };
  const strip = (list: string[] | undefined): string[] =>
    (list ?? [])
      .filter((e) => e.startsWith(PERMISSION_PREFIX))
      .map((e) => e.slice(PERMISSION_PREFIX.length));
  return { allow: strip(parsed.permissions?.allow), deny: strip(parsed.permissions?.deny) };
}

function main(): void {
  const registered = readRegisteredTools();
  if (registered.length === 0) {
    stderr.write(`check-mcp-permissions: no tools found under ${TOOLS_DIR}\n`);
    exit(1);
  }

  const { allow, deny } = readPermissions();
  const { uncovered, stale, conflicting } = reconcile({ registered, allow, deny });

  for (const t of uncovered) {
    stdout.write(`[FAIL] uncovered: ${PERMISSION_PREFIX}${t} is registered but in neither allow nor deny\n`);
  }
  for (const t of stale) {
    stdout.write(`[FAIL] stale: ${PERMISSION_PREFIX}${t} is listed but no longer registered\n`);
  }
  for (const t of conflicting) {
    stdout.write(`[FAIL] conflict: ${PERMISSION_PREFIX}${t} is in both allow and deny\n`);
  }

  const failures = uncovered.length + stale.length + conflicting.length;
  if (failures > 0) {
    stdout.write(`\n${failures} problem(s) found across ${registered.length} registered tools.\n`);
    exit(1);
  }

  stdout.write(
    `OK — ${registered.length} tools, all covered (${allow.length} allow / ${deny.length} deny).\n`,
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
    main();
  } catch (err) {
    stderr.write(`check-mcp-permissions: ${(err as Error).message}\n`);
    exit(1);
  }
}
