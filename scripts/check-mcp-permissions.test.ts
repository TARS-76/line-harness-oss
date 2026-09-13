import { describe, expect, it } from 'vitest';
import { extractToolNames, reconcile } from './check-mcp-permissions';

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
