import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunSpec } from './types';

/** build prod 600s + chờ sẵn sàng 120s + capture 135s, làm tròn lên */
export const MCP_TOOL_TIMEOUT_MS = 900_000;

export function buildClaudeArgs(spec: RunSpec, files: { systemPromptFile: string; settingsFile: string; mcpFile: string }): string[] {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', spec.model, '--effort', spec.effort,
    ...(spec.resume ? ['--resume', spec.sessionId] : ['--session-id', spec.sessionId]),
    '--permission-mode', 'dontAsk', '--setting-sources', spec.inheritUser ? 'user,project,local' : 'project,local',
    ...(spec.inheritUser ? [] : ['--tools', spec.tools.join(',')]), '--allowedTools', spec.allowedTools.join(','),
    '--append-system-prompt-file', files.systemPromptFile, '--settings', files.settingsFile,
    '--mcp-config', files.mcpFile, ...(spec.inheritUser || spec.userMcp ? [] : ['--strict-mcp-config']),
  ];
  for (const d of spec.addDirs) args.push('--add-dir', d);
  return args;
}

export function writeRunFiles(spec: RunSpec, guardHook: string): { systemPromptFile: string; settingsFile: string; mcpFile: string } {
  mkdirSync(spec.runDir, { recursive: true });
  const systemPromptFile = path.join(spec.runDir, 'system.md');
  const settingsFile = path.join(spec.runDir, 'settings.json');
  const mcpFile = path.join(spec.runDir, 'mcp.json');
  writeFileSync(systemPromptFile, spec.systemPrompt, 'utf8');
  writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guardHook, timeout: 10 }] }] } }), 'utf8');
  // Claude Code cắt mỗi tool call HTTP ở 60s nếu không có timeout; capture có thể chờ build prod + server sẵn sàng + các bước
  const mcpServers = spec.mcp
    ? { acctv: { type: 'http', url: spec.mcp.url, headers: { Authorization: `Bearer ${spec.mcp.token}` }, timeout: MCP_TOOL_TIMEOUT_MS } }
    : {};
  writeFileSync(mcpFile, JSON.stringify({ mcpServers }), 'utf8');
  return { systemPromptFile, settingsFile, mcpFile };
}
