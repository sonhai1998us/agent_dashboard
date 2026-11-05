// Demo/kiểm thử trên trình duyệt: Claude giả (tests/fixtures/fake-claude.mjs + demo-scenario.json), cổng 4778, ACCTV_HOME riêng trong thư mục tạm.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ACCTV_HOME ??= path.join(os.tmpdir(), 'acctv-demo');
process.env.ACCTV_CLAUDE_CMD ??= JSON.stringify({ command: process.execPath, prefixArgs: [path.join(root, 'tests', 'fixtures', 'fake-claude.mjs')] });
process.env.FAKE_CLAUDE_SCRIPT ??= path.join(root, 'tests', 'fixtures', 'demo-scenario.json');

const { loadConfig } = await import('@/src/core/config');
const { startServer } = await import('@/src/server/http');
const cfg = { ...loadConfig(), port: Number(process.env.ACCTV_PORT) || 4778 };
startServer({ cfg, dev: process.env.NODE_ENV !== 'production', withNext: true })
  .then((s) => console.log(`[acctv] Agent CCTV (demo, ACCTV_HOME=${cfg.home}) listening on ${s.url}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
