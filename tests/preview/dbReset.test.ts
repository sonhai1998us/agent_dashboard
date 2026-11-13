import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { runArgs } from '@/src/preview/dbReset';

// tiến trình con của lệnh (vd. trình duyệt của playwright) giữ pipe: phải kill cả nhóm thì mới trả về đúng hạn
describe.skipIf(process.platform === 'win32')('runArgs', () => {
  const cmd = ['-c', 'sleep 5; echo xong'];

  it('quá hạn: kill cả cây tiến trình, trả về ngay (code null)', async () => {
    const t0 = Date.now();
    const r = await runArgs('sh', cmd, os.tmpdir(), process.env, 300);
    expect(r.code).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('signal abort: kill cả cây tiến trình', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    const r = await runArgs('sh', cmd, os.tmpdir(), process.env, 60_000, ac.signal);
    expect(r.code).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('tham số đi nguyên văn, không qua shell', async () => {
    const r = await runArgs('printf', ['%s', '"; echo hacked'], os.tmpdir(), process.env, 5000);
    expect(r.tail).toBe('"; echo hacked');
  });
});
