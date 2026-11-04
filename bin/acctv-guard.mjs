#!/usr/bin/env node
import http from 'node:http';

const [port, agentId, token] = process.argv.slice(2);
const FAIL = '[acctv-guard] dashboard không phản hồi, từ chối để an toàn';
let done = false;

function finish(reason) {
  if (done) return;
  done = true;
  if (reason === null) return process.exit(0);
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  process.stdout.write(out + '\n', () => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

const TIMEOUT = Number(process.env.ACCTV_GUARD_TIMEOUT_MS) || 8000;
process.on('uncaughtException', () => finish(FAIL));
process.stdout.on('error', () => process.exit(0));
setTimeout(() => finish(FAIL), TIMEOUT);

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => finish(FAIL));
process.stdin.on('end', () => {
  try {
    const body = Buffer.concat(chunks);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(port),
        method: 'POST',
        path: `/api/guard?agent=${encodeURIComponent(agentId ?? '')}`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length },
        timeout: TIMEOUT,
      },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('error', () => finish(FAIL));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
            const ok = res.statusCode === 200 && j && typeof j === 'object';
            if (ok && j.allow === true) return finish(null);
            finish(ok && typeof j.reason === 'string' && j.reason ? j.reason : FAIL);
          } catch {
            finish(FAIL);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(FAIL));
    req.end(body);
  } catch {
    finish(FAIL);
  }
});
