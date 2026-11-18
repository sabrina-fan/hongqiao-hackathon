// Build with pnpm build, then run node --import tsx apps/server/test/run-settings-actions.mjs [Ego space ID].
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.ts';
import { createAmap } from '../src/radar/amap.ts';

const root = resolve(import.meta.dirname, '../../web');
const { preview } = createRequire(join(root, 'package.json'))('vite');
const results = resolve(import.meta.dirname, '../../../test-results');
await mkdir(results, { recursive: true });
const output = await mkdtemp(join(results, 'settings-actions-'));
const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-settings-'));
const now = () => Date.parse('2026-11-20T08:15:00Z');
const poi = {
  id: 'settings-poi',
  name: '验收收藏',
  address: '苏州市验收路',
  location: '120.647,31.318',
};
const server = createApp({
  dataDir,
  cookieSecret: randomBytes(32).toString('hex'),
  now,
  map: createAmap({
    key: 'fixture',
    now,
    fetcher: async () => Response.json({ status: '1', info: 'OK', pois: [poi] }),
  }),
  vision: async () => ({ kind: 'text', name: poi.name, excerpt: '合成来源', confidence: 'high' }),
});

// Hold exactly one matching request until the browser observes its pending state.
let gate;
function controls(vite) {
  vite.middlewares.use((req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__settings/arm' && req.method === 'POST') {
      assert(!gate);
      gate = { path: url.searchParams.get('path'), method: url.searchParams.get('method') };
      return res.writeHead(204).end();
    }
    if (url.pathname === '/__settings/release' && req.method === 'POST') {
      if (!gate?.release) return res.writeHead(409).end();
      const { release } = gate;
      gate = undefined;
      release(url.searchParams.get('result'));
      return res.writeHead(204).end();
    }
    if (gate?.path === url.pathname && gate.method === req.method) {
      if (gate.release) return res.writeHead(409).end();
      gate.release = (result) => {
        if (result === 'fail')
          return res.writeHead(503, { 'content-type': 'application/json' }).end('{}');
        // Simulate settings still showing recovery after another tab has replaced the session.
        if (result === 'recovery')
          return res
            .writeHead(200, {
              'content-type': 'application/json',
              'x-nextstop-erase-binding': 'a'.repeat(43),
            })
            .end('{"kind":"erase_recovery"}');
        next();
      };
      return;
    }
    next();
  });
}

async function browser(source) {
  const child = spawn('ego-browser', ['nodejs'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 180_000,
  });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') console.error(error);
  });
  const closed = once(child, 'close');
  child.stdin.end(source);
  const [code, signal] = await closed;
  assert.equal(code, 0, `Ego exited with ${code ?? signal}. Evidence: ${output}`);
}

let web;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = `http://127.0.0.1:${server.address().port}`;
  web = await preview({
    root,
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target }, '/health': { target } } },
    plugins: [{ name: 'settings-action-gates', configurePreviewServer: controls }],
  });
  const port = web.httpServer.address().port;
  const origin = `http://settings-${port}.localhost:${port}`;
  const space = process.argv[2] ? Number(process.argv[2]) : null;
  assert(space === null || Number.isSafeInteger(space));
  const image = resolve(import.meta.dirname, 'import-synthetic.png');
  const source = await readFile(
    new URL('../../../e2e/settings-actions.ego.mjs', import.meta.url),
    'utf8',
  );
  process.stdout.write(`Evidence: ${output}\n`);
  await browser(
    `const fixture = ${JSON.stringify({ origin, output, space, image, poi })};\n${source}`,
  );
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  await browser(`await (await taskSpace(${report.space})).finish({ keep: [] });`);
} finally {
  web?.httpServer.closeAllConnections();
  try {
    await web?.close();
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    await rm(dataDir, { recursive: true, force: true });
  }
}
