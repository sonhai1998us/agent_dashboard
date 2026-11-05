import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + '\n');

let role = '*';
try {
  const m = /^ROLE:\s*(\S+)/.exec(readFileSync(arg('--append-system-prompt-file'), 'utf8').split(/\r?\n/)[0] ?? '');
  if (m) role = m[1];
} catch { /* no prompt file */ }

const script = process.env.FAKE_CLAUDE_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8')) : {};
const turns = script[role] ?? script['*'] ?? [];
const turn = turns.find((t) => !t.when || stdin.includes(t.when));

let n = 0;
let sawResult = false;
const toolPair = (name, input, content, isError) => {
  const id = `${name}-${++n}`;
  out({ type: 'assistant', message: { role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name, input }] } });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
};

function runHook(cmd, input) {
  return new Promise((resolve) => {
    const p = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let o = '';
    p.stdout.on('data', (c) => { o += c; });
    p.on('close', () => resolve(o));
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(input));
  });
}

for (const step of turn?.steps ?? []) {
  if ('emit' in step) { if (step.emit?.type === 'result') sawResult = true; out(step.emit); }
  else if ('raw' in step) out(step.raw);
  else if ('stderr' in step) process.stderr.write(step.stderr);
  else if ('sleep' in step) await sleep(step.sleep);
  else if ('mcp' in step) {
    const cfg = JSON.parse(readFileSync(arg('--mcp-config'), 'utf8'));
    const srv = Object.values(cfg.mcpServers)[0];
    const id = ++n;
    // "{ticket}" trong args → id ticket lấy từ URL MCP (kịch bản dùng được cho mọi ticket)
    const ticket = new URL(srv.url).searchParams.get('ticket') ?? '';
    const args = JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('{ticket}', ticket));
    out({ type: 'assistant', message: { role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: `mcp-${id}`, name: `mcp__acctv__${step.mcp}`, input: args }] } });
    let text;
    try {
      const res = await fetch(srv.url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(srv.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: step.mcp, arguments: args } }),
      });
      const j = await res.json();
      text = j.result?.content?.[0]?.text ?? JSON.stringify(j.result ?? j.error ?? j);
    } catch (e) { text = `mcp error: ${e.message}`; }
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `mcp-${id}`, content: text }] } });
  } else if ('hook' in step) {
    const settings = JSON.parse(readFileSync(arg('--settings'), 'utf8'));
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    const raw = (await runHook(cmd, step.hook)).trim();
    let deny = false; let reason = 'ok';
    try {
      const h = JSON.parse(raw).hookSpecificOutput;
      if (h?.permissionDecision === 'deny') { deny = true; reason = h.permissionDecisionReason ?? ''; }
    } catch { /* allow */ }
    toolPair(step.hook.tool_name, step.hook.tool_input, reason, deny);
  } else if ('spawnChild' in step) {
    const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });
    if (process.env.FAKE_CLAUDE_CHILD_PID) writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID, String(c.pid));
  } else if ('exit' in step) {
    await new Promise((r) => process.stdout.write('', r));
    process.exit(step.exit);
  }
}
if (!sawResult) out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0 });
