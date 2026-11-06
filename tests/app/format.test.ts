import { describe, expect, test } from 'vitest';
import { cacheShare, estimateCost, fmtClock, fmtCost, fmtDuration, fmtPercent, fmtTokens } from '@/app/lib/format';

describe('format', () => {
  test('fmtCost', () => {
    expect(fmtCost(null)).toBe('—');
    expect(fmtCost(0.004)).toBe('<$0.01');
    expect(fmtCost(1.234)).toBe('~$1.23');
  });
  test('estimateCost', () => {
    expect(estimateCost('m', 1_000_000, 500_000, { m: { in: 3, out: 15 } })).toBe(10.5);
    expect(estimateCost('x', 1, 1, {})).toBeNull();
    expect(estimateCost(null, 1, 1, {})).toBeNull();
  });
  test('fmtDuration', () => {
    expect(fmtDuration(41000)).toBe('41s');
    expect(fmtDuration(207000)).toBe('3m27');
    expect(fmtDuration(3600000)).toBe('1h00m');
    expect(fmtDuration(3900000)).toBe('1h05m');
    expect(fmtDuration(-5)).toBe('0s');
  });
  test('fmtDuration: dưới 1 giây hiện ms/giây thập phân', () => {
    expect(fmtDuration(300)).toBe('0.3s');
  });
  test('fmtTokens', () => {
    expect(fmtTokens(212345)).toBe('212k');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
  });
  test('fmtClock theo giờ máy, HH:MM:SS', () => {
    const d = new Date(2026, 10, 2, 14, 2, 11).getTime();
    expect(fmtClock(d)).toBe('14:02:11');
  });
});

test('cacheShare / fmtPercent', () => {
  expect(cacheShare(960, 1000)).toBe(0.96);
  expect(cacheShare(0, 0)).toBeNull();
  expect(cacheShare(2000, 1000)).toBe(1);
  expect(fmtPercent(0.956)).toBe('96%');
  expect(fmtPercent(null)).toBe('—');
});
