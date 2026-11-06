import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTranscript, transcriptUsage } from '@/src/adapters/claude/usage';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-usage-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const line = (id: string, u: Record<string, number>, type = 'assistant') => JSON.stringify({ type, message: { id, usage: u } });

describe('transcriptUsage', () => {
  it('lấy số lớn nhất của mỗi message, tách cache, lọc theo id', () => {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, [
      line('m1', { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 8 }),
      line('m1', { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 546 }),
      line('m2', { input_tokens: 1, output_tokens: 20 }),
      line('m3', { input_tokens: 1, output_tokens: 20 }, 'user'),
      'không phải json',
      '',
    ].join('\n'));
    const all = transcriptUsage(f);
    expect(all.get('m1')).toEqual({ tokensIn: 1003, tokensOut: 546, cacheRead: 900, cacheWrite: 100 });
    expect(all.get('m2')).toEqual({ tokensIn: 1, tokensOut: 20, cacheRead: 0, cacheWrite: 0 });
    expect(all.has('m3')).toBe(false);
    expect([...transcriptUsage(f, new Set(['m2'])).keys()]).toEqual(['m2']);
    expect(transcriptUsage(path.join(dir, 'khong-co.jsonl')).size).toBe(0);
  });

  it('findTranscript: tìm trong mọi thư mục project; id lạ → null', () => {
    fs.mkdirSync(path.join(dir, 'projects', 'D--Work-a'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'projects', 'C--x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'C--x', 'abc-1.jsonl'), '');
    expect(findTranscript(dir, 'abc-1')).toBe(path.join(dir, 'projects', 'C--x', 'abc-1.jsonl'));
    expect(findTranscript(dir, 'khong-co')).toBeNull();
    expect(findTranscript(dir, '../x')).toBeNull();
    expect(findTranscript(path.join(dir, 'khong-co-dir'), 'abc-1')).toBeNull();
  });
});
