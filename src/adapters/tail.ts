import { readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import zlib from 'node:zlib';

export interface TailResult {
  lines: string[];
  offset: number;
  lineCount: number;
}

export interface TailChunk extends TailResult {
  /** Offset this chunk started from (the previous persisted offset). */
  startOffset: number;
}

export const CHUNK_BYTES = 2 * 1024 * 1024;
const ZST_BATCH_LINES = 5000;

/** Splits complete (newline-terminated) lines out of buf. Returns lines and consumed byte length. */
function splitComplete(buf: Buffer): { lines: string[]; consumed: number } {
  const last = buf.lastIndexOf(0x0a);
  if (last < 0) return { lines: [], consumed: 0 };
  const text = buf.subarray(0, last).toString('utf8');
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines: lines.filter((l) => l.length > 0), consumed: last + 1 };
}

async function* chunksJsonl(file: string, from: { offset: number; lines: number }, chunkBytes: number): AsyncGenerator<TailChunk> {
  const size = statSync(file).size;
  const truncated = size < from.offset;
  let pos = truncated ? 0 : from.offset;
  let lineCount = truncated ? 0 : from.lines;
  let committed = pos;
  if (size === pos) return;

  const fh = await open(file, 'r');
  try {
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(chunkBytes);
    while (pos < size) {
      const want = Math.min(chunkBytes, size - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
      const { lines, consumed } = splitComplete(data);
      carry = Buffer.from(data.subarray(consumed));
      if (consumed === 0) continue;
      const startOffset = committed;
      committed = pos - carry.length;
      lineCount += lines.length;
      yield { lines, offset: committed, lineCount, startOffset };
    }
  } finally {
    await fh.close();
  }
}

function* chunksZst(file: string, from: { offset: number; lines: number }): Generator<TailChunk> {
  const raw = readFileSync(file);
  const text = zlib.zstdDecompressSync(raw);
  const { lines: all } = splitComplete(text);
  const skip = from.offset > raw.length ? 0 : from.lines; // compressed file shrank: start over
  if (skip >= all.length) {
    yield { lines: [], offset: raw.length, lineCount: all.length, startOffset: from.offset };
    return;
  }
  for (let i = skip; i < all.length; i += ZST_BATCH_LINES) {
    const lines = all.slice(i, i + ZST_BATCH_LINES);
    yield { lines, offset: raw.length, lineCount: i + lines.length, startOffset: from.offset };
  }
}

/** Reads new lines in bounded chunks. `.jsonl`: byte offset; `.jsonl.zst`: whole file decompressed, `from.lines` skipped. */
export async function* tailChunks(
  file: string, from: { offset: number; lines: number }, chunkBytes: number = CHUNK_BYTES,
): AsyncGenerator<TailChunk> {
  if (file.toLowerCase().endsWith('.zst')) yield* chunksZst(file, from);
  else yield* chunksJsonl(file, from, chunkBytes);
}

/** Convenience: reads everything new at once (small files / tests). */
export async function readNewLines(file: string, from: { offset: number; lines: number }): Promise<TailResult> {
  const lines: string[] = [];
  let offset = from.offset;
  let lineCount = from.lines;
  let any = false;
  for await (const c of tailChunks(file, from)) {
    any = true;
    for (const l of c.lines) lines.push(l);
    offset = c.offset;
    lineCount = c.lineCount;
  }
  if (!any) {
    const size = statSync(file).size;
    if (size < from.offset) return { lines: [], offset: 0, lineCount: 0 };
    return { lines: [], offset: from.offset, lineCount: from.lines };
  }
  return { lines, offset, lineCount };
}
