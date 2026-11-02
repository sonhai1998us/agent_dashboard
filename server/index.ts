import { startServer } from '@/src/server/http';

export { startServer };

const isMain = process.argv[1] !== undefined && /[\\/]server[\\/]index\.[cm]?[jt]s$/.test(process.argv[1]);

if (isMain) {
  const dev = process.env.NODE_ENV !== 'production';
  startServer({ dev, withNext: true })
    .then((s) => console.log(`[acctv] Agent CCTV listening on ${s.url}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
