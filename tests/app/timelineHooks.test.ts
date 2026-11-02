import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('AgentTimeline: không có hook nào đặt sau early return (Rules of Hooks)', () => {
  const src = readFileSync('app/components/AgentTimeline.tsx', 'utf8');
  const body = src.slice(src.indexOf('export default function AgentTimeline'), src.indexOf('\nconst Lane = memo'));
  const early = body.indexOf('  if (!root) {');
  expect(early).toBeGreaterThan(0);
  expect(body.slice(early)).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Live)\(/);
});
