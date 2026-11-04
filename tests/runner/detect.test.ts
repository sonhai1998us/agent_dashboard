import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findExecutable } from '@/src/runner/detect';

const win = process.platform === 'win32';
const E = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'det-'));

describe('findExecutable', () => {
  it.runIf(win)('finds claude.exe on PATH', () => {
    const d = tmp(); writeFileSync(path.join(d, 'claude.exe'), '');
    expect(findExecutable('claude', null, E({ PATH: d }))).toBe(path.join(d, 'claude.exe'));
  });
  it.runIf(win)('ignores claude.cmd', () => {
    const d = tmp(); writeFileSync(path.join(d, 'claude.cmd'), '');
    expect(findExecutable('claude', null, E({ PATH: d, USERPROFILE: d }))).toBeNull();
  });
  it.runIf(win)('falls back to %USERPROFILE%\.local\bin\claude.exe', () => {
    const d = tmp(); mkdirSync(path.join(d, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(d, '.local', 'bin', 'claude.exe'), '');
    expect(findExecutable('claude', null, E({ PATH: '', USERPROFILE: d }))).toBe(path.join(d, '.local', 'bin', 'claude.exe'));
  });
  it('ignores an override that is a directory', () => {
    const d = tmp();
    expect(findExecutable('claude', d, E({ PATH: '' }))).toBeNull();
  });
  it('accepts an override that is a file', () => {
    const d = tmp(); const f = path.join(d, 'my-claude'); writeFileSync(f, '');
    expect(findExecutable('claude', f, E({ PATH: '' }))).toBe(f);
  });
});
