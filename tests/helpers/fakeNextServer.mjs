// Server giả thay cho next dev / next build / next start trong test PreviewServer.
// serve <port>: HTTP 200, body JSON có FAKE_TAG / FROM_FILE / PORT. build: đếm số lần build vào built.txt. fail: in boom rồi thoát 1.
import fs from 'node:fs';
import http from 'node:http';

const [cmd, port] = process.argv.slice(2);
if (cmd === 'build') {
  const n = fs.existsSync('built.txt') ? Number(fs.readFileSync('built.txt', 'utf8')) + 1 : 1;
  fs.writeFileSync('built.txt', String(n));
  console.log(`built ${n}`);
  const wait = Number(process.env.FAKE_BUILD_MS ?? 0);
  setTimeout(() => process.exit(0), wait);
} else if (cmd === 'fail') {
  console.error('boom');
  process.exit(1);
} else if (cmd === 'serve') {
  const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
  setTimeout(() => {
    http
      .createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ tag: process.env.FAKE_TAG ?? null, fromFile: process.env.FROM_FILE ?? null, port: process.env.PORT ?? null }));
      })
      .listen(Number(port), () => console.log(`ready on ${port}`));
  }, delay);
} else {
  console.error(`lệnh lạ: ${cmd}`);
  process.exit(2);
}
