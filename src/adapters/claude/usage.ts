import fs from 'node:fs';
import path from 'node:path';

export interface MessageUsage { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }

/** File transcript của session trong `<claudeDir>/projects/<thư mục>/<sessionId>.jsonl`; null nếu không thấy. */
export function findTranscript(claudeDir: string, sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const root = path.join(claudeDir, 'projects');
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/**
 * Usage cuối cùng của từng message model trong transcript (theo message id).
 * stream-json của `claude -p` chỉ có output_tokens lúc message mới bắt đầu (vd. 2, 8),
 * còn transcript ghi số cuối; lấy giá trị lớn nhất nếu một message ghi nhiều dòng.
 */
export function transcriptUsage(file: string, ids?: Set<string>): Map<string, MessageUsage> {
  const out = new Map<string, MessageUsage>();
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const msg = rec?.message;
    const u = msg?.usage;
    if (rec?.type !== 'assistant' || !u || typeof msg.id !== 'string') continue;
    if (ids && !ids.has(msg.id)) continue;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const next: MessageUsage = { tokensIn: (u.input_tokens ?? 0) + cacheRead + cacheWrite, tokensOut: u.output_tokens ?? 0, cacheRead, cacheWrite };
    const prev = out.get(msg.id);
    out.set(msg.id, prev ? {
      tokensIn: Math.max(prev.tokensIn, next.tokensIn), tokensOut: Math.max(prev.tokensOut, next.tokensOut),
      cacheRead: Math.max(prev.cacheRead, next.cacheRead), cacheWrite: Math.max(prev.cacheWrite, next.cacheWrite),
    } : next);
  }
  return out;
}
