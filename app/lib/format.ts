import type { AlertKind } from '@/src/core/model';
import type { Settings } from '@/src/core/config';

/** Nhãn tiếng Việt của loại cảnh báo (giao diện và CLI). */
export const ALERT_LABEL: Record<AlertKind, string> = {
  stuck: 'kẹt',
  long_tool: 'tool lâu',
  loop: 'lặp',
  error_burst: 'lỗi liên tiếp',
  guard: 'bị chặn',
};

const pad = (n: number): string => String(n).padStart(2, '0');

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${(Math.round(ms / 100) / 10).toString()}s`;
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m${pad(total % 60)}`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(Math.round(n / 100_000) / 10).toString()}M`;
}

export function fmtCost(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd < 0.01) return '<$0.01';
  return `~$${usd.toFixed(2)}`;
}

/** Ước tính USD từ token và bảng giá (USD / 1M token); model lạ → null. */
export function estimateCost(model: string | null, tokensIn: number, tokensOut: number, prices: Settings['prices']): number | null {
  const p = model ? prices[model] : undefined;
  if (!p) return null;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Phần token đầu vào đọc từ prompt cache (0–1); null khi chưa có token đầu vào. */
export function cacheShare(cacheRead: number, tokensIn: number): number | null {
  return tokensIn > 0 ? Math.min(1, Math.max(0, cacheRead / tokensIn)) : null;
}

export function fmtPercent(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}
