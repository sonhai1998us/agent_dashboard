import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\n');
const f = process.env.FAKE_CODEX_FIXTURE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex', 'exec.jsonl');
process.stdout.write(readFileSync(f, 'utf8'));
if (process.env.FAKE_CODEX_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CODEX_SLEEP)));
