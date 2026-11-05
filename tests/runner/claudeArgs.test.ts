import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildClaudeArgs, writeRunFiles } from '@/src/runner/claudeArgs';
import type { RunSpec } from '@/src/runner/types';

const base = (over: Partial<RunSpec> = {}): RunSpec => ({
  agentId: 'acctv:T-1:dev-1', ticketId: 'T-1', role: 'dev', agent: 'claude', label: 'Dev 1', parentId: null,
  cwd: 'D:\\proj', model: 'claude-sonnet-5-5', effort: 'high', prompt: 'hi', systemPrompt: 'sys', sessionId: 'sid-1', resume: false,
  tools: ['Read', 'Edit'], allowedTools: ['Read', 'Edit'], addDirs: ['D:\\a', 'D:\\b'], runDir: tmpdir(),
  mcp: null, guard: { port: 1234, token: 'g' }, ...over,
});
const files = { systemPromptFile: 'sys.md', settingsFile: 'set.json', mcpFile: 'mcp.json' };

describe('buildClaudeArgs', () => {
  it('uses --session-id xor --resume', () => {
    const a = buildClaudeArgs(base(), files);
    expect(a).toContain('--session-id');
    expect(a).not.toContain('--resume');
    const b = buildClaudeArgs(base({ resume: true }), files);
    expect(b).toContain('--resume');
    expect(b).not.toContain('--session-id');
  });
  it('follows the specified order and keeps the prompt off argv', () => {
    const a = buildClaudeArgs(base(), files);
    expect(a).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5', '--effort', 'high',
      '--session-id', 'sid-1', '--permission-mode', 'dontAsk', '--setting-sources', 'project,local',
      '--tools', 'Read,Edit', '--allowedTools', 'Read,Edit',
      '--append-system-prompt-file', 'sys.md', '--settings', 'set.json', '--mcp-config', 'mcp.json', '--strict-mcp-config',
      '--add-dir', 'D:\\a', '--add-dir', 'D:\\b',
    ]);
    expect(a).not.toContain('hi');
  });
  it('never mentions bypass or dangerously', () => {
    for (const s of [base(), base({ resume: true })]) {
      expect(buildClaudeArgs(s, files).some((x) => /bypass|dangerously/i.test(x))).toBe(false);
    }
  });
});

describe('writeRunFiles', () => {
  it('writes files for a path with spaces and diacritics', () => {
    const runDir = path.join(mkdtempSync(path.join(tmpdir(), 'acctv-')), 'Dự án', 'my run');
    const hook = '"C:\\Program Files\\node\\node.exe" "D:\\Dự án\\guard hook.mjs"';
    const f = writeRunFiles(base({ runDir, mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' } }), hook);
    expect(readFileSync(f.systemPromptFile, 'utf8')).toBe('sys');
    expect(JSON.parse(readFileSync(f.settingsFile, 'utf8'))).toEqual({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hook, timeout: 10 }] }] },
    });
    expect(JSON.parse(readFileSync(f.mcpFile, 'utf8')).mcpServers.acctv).toEqual({
      type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer tok' },
    });
  });
  it('writes empty mcpServers without mcp', () => {
    const f = writeRunFiles(base({ runDir: mkdtempSync(path.join(tmpdir(), 'acctv-')) }), 'x');
    expect(JSON.parse(readFileSync(f.mcpFile, 'utf8'))).toEqual({ mcpServers: {} });
  });
});
