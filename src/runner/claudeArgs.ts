import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunSpec } from './types';

export function buildClaudeArgs(spec: RunSpec, files: { systemPromptFile: string; settingsFile: string; mcpFile: string }): string[] {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', spec.model, '--effort', spec.effort,
    ...(spec.resume ? ['--resume', spec.sessionId] : ['--session-id', spec.sessionId]),
    '--permission-mode', 'dontAsk', '--setting-sources', 'project,local',
    '--tools', spec.tools.join(','), '--allowedTools', spec.allowedTools.join(','),
    '--append-system-prompt-file', files.systemPromptFile, '--settings', files.settingsFile,
    '--mcp-config', files.mcpFile, '--strict-mcp-config',
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
  const mcpServers = spec.mcp
    ? { acctv: { type: 'http', url: spec.mcp.url, headers: { Authorization: `Bearer ${spec.mcp.token}` } } }
    : {};
  writeFileSync(mcpFile, JSON.stringify({ mcpServers }), 'utf8');
  return { systemPromptFile, settingsFile, mcpFile };
}
