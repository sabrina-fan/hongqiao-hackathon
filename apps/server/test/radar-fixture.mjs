// The browser exercises the app's real HTTP routes, Amap parser and SQLite writes.
// Only Amap transport is replaced. The fixture has no network API switch in production.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/app.ts';
import { createAmap } from '../src/radar/amap.ts';

const fixedWindow = process.argv.includes('--fixed-next-stop');
const now = fixedWindow ? () => Date.parse('2026-11-18T08:00:00Z') : Date.now;
const fixedPoint = '120.642,31.314';
const catalog = [
  { id: 'qa-origin', name: '验收起点', address: '测试街一号', location: '120.10,31.10' },
  {
    id: 'qa-stop',
    name: '验收书店',
    address: '测试街二号',
    location: fixedWindow ? '120.636,31.306' : '120.11,31.11',
  },
  { id: 'qa-park', name: '验收公园', address: '测试街三号', location: '120.12,31.097' },
  { id: 'qa-tea', name: '验收茶馆', address: '测试街四号', location: '120.098,31.12' },
];
function mapResponse(url) {
  let data;
  if (url.pathname === '/v5/place/text') {
    data = { pois: catalog.filter((row) => row.name.includes(url.searchParams.get('keywords'))) };
  } else if (url.pathname === '/v5/place/around') {
    data = { pois: catalog.filter((row) => row.id !== 'qa-origin') };
  } else if (url.pathname === '/v5/place/detail') {
    data = {
      pois: catalog.filter((row) => url.searchParams.get('id').split('|').includes(row.id)),
    };
  } else if (url.pathname === '/v3/assistant/coordinate/convert') {
    data = { locations: '120.633087,31.309861' };
  } else if (url.pathname === '/v3/geocode/geo') {
    data = { geocodes: [{ location: fixedPoint, level: '门牌号', adcode: '320508' }] };
  } else if (url.pathname === '/v3/distance') {
    const duration =
      url.searchParams.get('destination') === fixedPoint ? '900' : fixedWindow ? '480' : '420';
    data = {
      results: [
        {
          origin_id: '1',
          dest_id: '1',
          distance: url.searchParams.get('destination') === '120.098,31.12' ? '1800' : '600',
          duration,
          info: 'OK',
        },
      ],
    };
  } else throw new Error('Unexpected fixture map endpoint');
  return Response.json({ status: '1', info: 'OK', ...data });
}

const directory = await mkdtemp(join(tmpdir(), 'nextstop-browser-'));
const server = createApp({
  dataDir: directory,
  cookieSecret: randomBytes(32).toString('hex'),
  map: createAmap({ key: 'unused', fetcher: mapResponse, now }),
  now,
});
let web;
async function close() {
  await web?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
const disconnected = once(process, 'disconnect');
try {
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const target = `http://127.0.0.1:${server.address().port}`;
  const root = new URL('../../web/', import.meta.url);
  const requireWeb = createRequire(new URL('package.json', root));
  const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href);
  web = await createServer({
    root: fileURLToPath(root),
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api': { target }, '/health': { target } },
    },
  });
  await web.listen();
  const port = web.httpServer.address().port;
  // Cookies ignore port numbers. A fresh loopback hostname keeps the developer's guest cookie intact.
  if (process.connected) process.send({ origin: `http://qa-${port}.localhost:${port}` });
  await disconnected;
} finally {
  await close();
}
