import { describe, expect, test } from 'vitest';
import type { Ticket } from '@/src/tickets/model';
import { recentDirs } from '@/app/lib/recentDirs';

const t = (dir: string, createdAt: number) => ({ dir, createdAt }) as Ticket;

describe('recentDirs', () => {
  test('bỏ trùng không phân biệt hoa thường, giữ bản mới nhất, mới nhất trước', () => {
    expect(recentDirs([t('D:\a', 1), t('D:\b', 2), t('d:\A', 3)])).toEqual(['d:\A', 'D:\b']);
  });
  test('tối đa 8', () => {
    const ts = Array.from({ length: 12 }, (_, i) => t(`D:\p${i}`, i));
    const r = recentDirs(ts);
    expect(r).toHaveLength(8);
    expect(r[0]).toBe('D:\p11');
  });
  test('max tuỳ chỉnh và mảng rỗng', () => {
    expect(recentDirs([])).toEqual([]);
    expect(recentDirs([t('x', 1), t('y', 2)], 1)).toEqual(['y']);
  });
});
