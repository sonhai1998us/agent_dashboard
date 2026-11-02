import { createReadStream, readFileSync, statSync } from 'node:fs';
import zlib from 'node:zlib';

export interface TailResult {
  lines: string[];
  offset: number;
  lineCount: number;
}

/** Splits complete (newline-terminated) lines out of buf. Returns lines and consumed byte length. */
function splitComplete(buf: Buffer): { lines: string[]; consumed: number } {
  const last = buf.lastIndexOf(0x0a);
  if (last < 0) return { lines: [], consumed: 0 };
  const text = buf.subarray(0, last).toString('utf8');
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines: lines.filter((l) => l.length > 0), consumed: last + 1 };
}

async function readJsonl(file: string, from: { offset: number; lines: number }): Promise<TailResult> {
  const size = statSync(file).size;
  const truncated = size < from.offset;
  const start = truncated ? 0 : from.offset;
  const baseLines = truncated ? 0 : from.lines;
  if (size === start) return { lines: [], offset: start, lineCount: baseLines };

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file, { start });
    s.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    s.on('error', reject);
    s.on('end', () => resolve());
  });
  const { lines, consumed } = splitComplete(Buffer.concat(chunks));
  return { lines, offset: start + consumed, lineCount: baseLines + lines.length };
}

function readZst(file: string, from: { offset: number; lines: number }): TailResult {
  const raw = readFileSync(file);
  const text = zlib.zstdDecompressSync(raw);
  const { lines: all } = splitComplete(text);
  const skip = from.offset > raw.length ? 0 : from.lines; // compressed file shrank: start over
  return { lines: all.slice(skip), offset: raw.length, lineCount: all.length };
}

/**
 * Reads lines not yet seen. `.jsonl`: streamed from the byte offset, only newline-terminated lines returned.
 * `.jsonl.zst`: whole file decompressed, first `from.lines` lines skipped.
 */
export async function readNewLines(file: string, from: { offset: number; lines: number }): Promise<TailResult> {
  if (file.toLowerCase().endsWith('.zst')) return readZst(file, from);
  return readJsonl(file, from);
}
