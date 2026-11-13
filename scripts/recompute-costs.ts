/**
 * Tính lại cost_usd của managed agent (runner claude) từ transcript của Claude Code.
 * Trước bản sửa ở orchestrator, dashboard cộng total_cost_usd của mỗi lượt --resume, mà số đó đã cộng dồn cả session,
 * nên Controller và agent bị resume bị đếm trùng.
 *
 *   npx tsx scripts/recompute-costs.ts            # chỉ in, không ghi
 *   npx tsx scripts/recompute-costs.ts --apply    # ghi vào DB (tắt dashboard trước)
 *
 * Biến môi trường: ACCTV_HOME (mặc định ~/.acctv), ACCTV_CLAUDE_DIR (mặc định ~/.claude).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** USD / 1M token. Ghi cache: 5 phút 1.25× input, 1 giờ 2× input. */
interface Price { in: number; out: number; read: number }
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.1 },
  'claude-fable-5-1': { in: 10, out: 50, read: 0.25 },
};
// Haiku 5.5: hai mức theo độ dài prompt (≤ 100K token và lớn hơn), đọc cache 0.1× input
const HAIKU = { small: { in: 0.1, out: 0.5, read: 0.01 }, large: { in: 0.5, out: 2.5, read: 0.05 }, limit: 100_000 };

export interface Usage {
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Chi phí một message của model; null khi chưa có giá cho model đó. */
export function messageCost(model: string, u: Usage): number | null {
  const inp = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const p = model === 'claude-haiku-5-5' ? (inp + read + write > HAIKU.limit ? HAIKU.large : HAIKU.small) : PRICES[model];
  if (!p) return null;
  // không có phần tách theo TTL thì coi như 5 phút
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : write;
  return (inp * p.in + (u.output_tokens ?? 0) * p.out + read * p.read + w5m * p.in * 1.25 + w1h * p.in * 2) / 1e6;
}

/** Tổng chi phí một transcript; mỗi message id tính một lần (Claude Code ghi một dòng cho mỗi content block). */
export function transcriptCost(jsonl: string): { usd: number; unknown: string[] } {
  const last = new Map<string, { model: string; usage: Usage }>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let r: { type?: string; message?: { id?: string; model?: string; usage?: Usage } };
    try { r = JSON.parse(line); } catch { continue; }
    const m = r.message;
    if (r.type !== 'assistant' || !m?.id || !m.model || !m.usage) continue;
    last.set(m.id, { model: m.model, usage: m.usage });
  }
  let usd = 0;
  const unknown = new Set<string>();
  for (const { model, usage } of last.values()) {
    if (model === '<synthetic>') continue; // message do CLI tự tạo, không gọi API
    const c = messageCost(model, usage);
    if (c === null) unknown.add(model); else usd += c;
  }
  return { usd, unknown: [...unknown] };
}

// shortcut: chỉ đọc <projects>/*/<session>.jsonl, chưa gộp transcript subagent con nếu sau này Claude Code tách ra thư mục riêng
function findTranscript(claudeDir: string, sessionId: string): string | null {
  const root = path.join(claudeDir, 'projects');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const TERMINAL = ['done', 'failed', 'stopped', 'interrupted', 'cancelled'];

function main(): void {
  const apply = process.argv.includes('--apply');
  const home = process.env.ACCTV_HOME ?? path.join(os.homedir(), '.acctv');
  const claudeDir = process.env.ACCTV_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
  const db = new DatabaseSync(path.join(home, 'acctv.db'));
  const rows = db.prepare(
    "SELECT agent_id, ticket_id, role, state, session_id, cost_usd FROM managed_agents WHERE runner = 'claude' ORDER BY created_at",
  ).all() as { agent_id: string; ticket_id: string; role: string; state: string; session_id: string; cost_usd: number | null }[];

  const update = db.prepare('UPDATE managed_agents SET cost_usd = ? WHERE agent_id = ?');
  let before = 0, after = 0, changed = 0;
  for (const r of rows) {
    const f = findTranscript(claudeDir, r.session_id);
    const old = r.cost_usd ?? 0;
    if (!f) { console.log(`${r.agent_id.padEnd(28)} bỏ qua: không thấy transcript`); before += old; after += old; continue; }
    const { usd, unknown } = transcriptCost(fs.readFileSync(f, 'utf8'));
    if (unknown.length) { console.log(`${r.agent_id.padEnd(28)} bỏ qua: chưa có giá cho ${unknown.join(', ')}`); before += old; after += old; continue; }
    // agent còn chạy: orchestrator vẫn ghi cost, không đụng tới
    const live = !TERMINAL.includes(r.state);
    const diff = usd - old;
    const mark = Math.abs(diff) < 0.005 ? 'khớp' : live ? 'đang chạy, giữ nguyên' : diff < 0 ? 'đếm trùng' : 'thiếu';
    console.log(`${r.agent_id.padEnd(28)} ${r.role.padEnd(10)} $${old.toFixed(3).padStart(7)} → $${usd.toFixed(3).padStart(7)}  ${mark}`);
    before += old;
    if (live || Math.abs(diff) < 0.005) { after += old; continue; }
    after += usd;
    changed++;
    if (apply) update.run(usd, r.agent_id);
  }
  console.log(`\nTổng: $${before.toFixed(2)} → $${after.toFixed(2)}; ${changed} agent ${apply ? 'đã cập nhật' : 'sẽ cập nhật (thêm --apply để ghi)'}`);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
