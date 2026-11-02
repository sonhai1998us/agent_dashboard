import { createHash } from 'node:crypto';

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');

function sortKeys(v: unknown): unknown {
  if (typeof v === 'string') return squash(v);
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function normalize(input: unknown): string {
  if (typeof input === 'string') return squash(input);
  return JSON.stringify(sortKeys(input)) ?? '';
}

export function inputHash(toolName: string, input: unknown): { hash: string; preview: string } {
  const norm = normalize(input);
  const hash = createHash('sha1').update(toolName + '\0' + norm).digest('hex').slice(0, 12);
  return { hash, preview: norm.slice(0, 200) };
}
