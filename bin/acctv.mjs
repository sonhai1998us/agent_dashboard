#!/usr/bin/env node
import { register } from 'tsx/esm/api';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// node:sqlite in Node 22 prints an ExperimentalWarning on every start; hide only that one.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.error(`(node:${process.pid}) ${w.name}: ${w.message}`);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
register({ tsconfig: path.join(root, 'tsconfig.json') });

const { main } = await import(pathToFileURL(path.join(root, 'cli', 'acctv.ts')).href);

const ac = new AbortController();
process.once('SIGINT', () => ac.abort());
process.once('SIGTERM', () => ac.abort());

const code = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  width: process.stdout.columns || 100,
  signal: ac.signal,
});
process.exit(code);
