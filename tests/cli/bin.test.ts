import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BIN = path.resolve('bin/acctv.mjs');

const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 30000 });

test('bin: --help in đủ hướng dẫn và thoát mã 0; lệnh lạ thoát mã 1', () => {
  const ok = run(['--help']);
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('Dùng: acctv');
  expect(ok.stdout).toContain('Mọi lệnh nhận --port N');
  const bad = run(['khong-co-lenh']);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('Lệnh không biết');
}, 60000);

test('bin: đặt process.exitCode thay vì process.exit để stdout kịp xả', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  expect(src).toMatch(/process\.exitCode\s*=\s*code/);
  expect(src).not.toMatch(/process\.exit\(code\)\s*;?\s*$/m);
});

test('package.json: engines.node >= 22.15 (zlib.zstdDecompressSync)', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  expect(pkg.engines.node).toBe('>=22.15');
  expect(fs.readFileSync('README.md', 'utf8')).toContain('>= 22.15');
});
