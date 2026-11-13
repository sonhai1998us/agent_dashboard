import { test, expect } from 'vitest';
import { messageCost, transcriptCost } from '../../scripts/recompute-costs';

test('messageCost: input, output, đọc cache, ghi cache 5 phút / 1 giờ', () => {
  // Sonnet 5.5: 1M đọc cache $0.10 + 1M ghi 1 giờ $4 + 1M output $10
  expect(messageCost('claude-sonnet-5-5', {
    cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6, output_tokens: 1e6,
    cache_creation: { ephemeral_1h_input_tokens: 1e6 },
  })).toBeCloseTo(14.1, 6);
  // không có phần tách TTL: ghi cache tính 5 phút (1.25×)
  expect(messageCost('claude-opus-5-5', { input_tokens: 1e6, cache_creation_input_tokens: 1e6 })).toBeCloseTo(4 + 5, 6);
  // Haiku 5.5: prompt > 100K dùng mức giá lớn
  expect(messageCost('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1e6 })).toBeCloseTo(0.005 + 0.5, 6);
  expect(messageCost('claude-haiku-5-5', { input_tokens: 200_000 })).toBeCloseTo(0.1, 6);
  expect(messageCost('model-la', { input_tokens: 1 })).toBeNull();
});

test('transcriptCost: mỗi message id tính một lần, bỏ synthetic, báo model chưa có giá', () => {
  const line = (id: string, model: string, out: number) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { output_tokens: out } } });
  const jsonl = [
    line('m1', 'claude-sonnet-5-5', 1e6), line('m1', 'claude-sonnet-5-5', 1e6), // cùng message, hai content block
    line('m2', '<synthetic>', 1e6),
    JSON.stringify({ type: 'user', message: { content: 'x' } }),
    'not json',
    line('m3', 'model-la', 5),
  ].join('\n');
  expect(transcriptCost(jsonl)).toEqual({ usd: 10, unknown: ['model-la'] });
});
