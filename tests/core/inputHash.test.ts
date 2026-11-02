import { test, expect } from 'vitest';
import { inputHash } from '@/src/core/inputHash';

test('inputHash không phụ thuộc thứ tự key và khoảng trắng', () => {
  expect(inputHash('Bash', { command: 'npm  test', timeout: 1 }).hash).toBe(
    inputHash('Bash', { timeout: 1, command: 'npm test ' }).hash,
  );
  expect(inputHash('Bash', { command: 'npm test' }).hash).not.toBe(
    inputHash('Read', { command: 'npm test' }).hash,
  );
});

test('inputHash trả về 12 ký tự hex', () => {
  expect(inputHash('Bash', 'ls').hash).toMatch(/^[0-9a-f]{12}$/);
});

test('inputHash sắp xếp key đệ quy', () => {
  expect(inputHash('T', { a: { y: 1, x: 2 }, b: [{ q: 1, p: 2 }] }).hash).toBe(
    inputHash('T', { b: [{ p: 2, q: 1 }], a: { x: 2, y: 1 } }).hash,
  );
});

test('preview cắt ở 200 ký tự', () => {
  const p = inputHash('Bash', 'x'.repeat(500)).preview;
  expect(p.length).toBe(200);
  expect(inputHash('Bash', 'ls').preview).toBe('ls');
});
