// Run from the repository root after `pnpm build`: node --import tsx apps/server/test/run-ego-actions.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app.ts';
import { createAmap } from '../src/radar/amap.ts';

const webRoot = resolve('apps/web');
const requireWeb = createRequire(join(webRoot, 'package.json'));
const { preview } = await import(pathToFileURL(requireWeb.resolve('vite')).href);

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
const evidence = resolve('test-results');
await mkdir(evidence, { recursive: true });
const output = await mkdtemp(join(evidence, `actions-${sha.slice(0, 7)}-`));
const sandbox = await mkdtemp(join(tmpdir(), 'nextstop-ego-actions-'));
const time = Date.parse('2026-11-20T08:15:00Z');
const places = [
  ['pingjiang', '平江历史街区', '苏州平江路'],
  ['north', '山塘街北口', '苏州广济路 3 号'],
  ['south', '山塘街南口', '苏州山塘街 2 号'],
  ['garden', '拙政园', '苏州东北街 178 号'],
  ['museum', '苏州博物馆', '苏州东北街 204 号'],
  ['dinner', '验收晚餐', '苏州临顿路 20 号'],
].map(([id, name, address], index) => ({
  id,
  name,
  address,
  location: `${120.63 + index * 0.001},31.31`,
}));
const now = () => time;
const map = createAmap({
  key: 'fixture',
  now,
  fetcher(input) {
    const { pathname, searchParams } = new URL(input);
    if (pathname === '/v3/distance') {
      const origins = searchParams.get('origins').split('|');
      return Response.json({
        status: '1',
        info: 'OK',
        results: origins.map((_, index) => ({
          origin_id: String(index + 1),
          dest_id: '1',
          distance: '400',
          duration: '300',
          info: 'OK',
        })),
      });
    }
    if (pathname === '/v5/place/detail') {
      const ids = searchParams.get('id')?.split('|') ?? [];
      return Response.json({
        status: '1',
        info: 'OK',
        pois: places.filter(({ id }) => ids.includes(id)),
      });
    }
    assert.equal(pathname, '/v5/place/text');
    const query = searchParams.get('keywords');
    return Response.json({
      status: '1',
      info: 'OK',
      pois: places.filter(({ name, address }) => name.includes(query) || address === query),
    });
  },
});
const recognition = Promise.withResolvers();
let visionCalls = 0;
const server = createApp({
  dataDir: join(sandbox, 'data'),
  cookieSecret: randomBytes(32).toString('hex'),
  map,
  now,
  async vision() {
    const index = ++visionCalls;
    if (index === 4) throw new Error('Controlled recognition failure');
    if (index === 5) return { kind: 'guess', name: '苏州博物馆', confidence: 'low' };
    if (index === 7) await recognition.promise;
    const name = ['平江历史街区', '平江历史街区', '山塘街'][index - 1];
    return name
      ? { kind: 'text', name, excerpt: `合成片段 ${index}`, confidence: 'high' }
      : { kind: 'unrecognized' };
  },
});

// Pause exactly one browser request at the local proxy until the test has inspected its pending state.
let gate;
const controls = {
  name: 'ego-action-fixture',
  configurePreviewServer(vite) {
    vite.middlewares.use('/__fixture', (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/arm') {
        assert.ok(!gate || gate.released, 'Release the previous gate first');
        gate = {
          path: url.searchParams.get('path'),
          method: url.searchParams.get('method'),
          latch: Promise.withResolvers(),
          hits: 0,
          released: false,
        };
        response.writeHead(204).end();
      } else if (request.method === 'POST' && url.pathname === '/release') {
        gate.released = true;
        gate.latch.resolve(url.searchParams.has('fail'));
        response.writeHead(204).end();
      } else if (request.method === 'POST' && url.pathname === '/recognition') {
        recognition.resolve();
        response.writeHead(204).end();
      } else if (url.pathname === '/state') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ hits: gate?.hits ?? 0, visionCalls }));
      } else {
        response.writeHead(404).end();
      }
    });
    vite.middlewares.use((request, response, next) => {
      const pending = gate;
      if (!pending || request.url !== pending.path || request.method !== pending.method)
        return next();
      pending.hits += 1;
      if (pending.hits !== 1) return next();
      void pending.latch.promise.then((fail) => {
        if (!fail) return next();
        request.resume();
        response.setHeader('content-type', 'application/json');
        response
          .writeHead(503)
          .end(
            JSON.stringify({ error: { code: 'FIXTURE_FAILURE', message: '受控失败，请重试。' } }),
          );
      });
    });
  },
};

async function browser(source, timeout) {
  const child = spawn('ego-browser', ['nodejs'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout,
  });
  const result = once(child, 'close');
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') console.error(error);
  });
  child.stdin.end(source);
  const [code, signal] = await result;
  assert.equal(code, 0, `Ego Lite exited with ${code ?? signal}. Evidence: ${output}`);
}

let web;
try {
  const png = resolve('apps/server/test/import-synthetic.png');
  const files = Array.from({ length: 9 }, (_, index) => join(sandbox, `攻略-${index + 1}.png`));
  await Promise.all(files.map((file) => copyFile(png, file)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = `http://127.0.0.1:${server.address().port}`;
  web = await preview({
    root: webRoot,
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target }, '/health': { target } } },
    plugins: [controls],
  });
  const port = web.httpServer.address().port;
  const origin = `http://qa-actions-${randomBytes(4).toString('hex')}.localhost:${port}`;
  const source = await readFile(resolve('e2e/ego-actions.browser.mjs'), 'utf8');
  process.stdout.write(`Evidence directory: ${output}\n`);
  await browser(
    `const settings = ${JSON.stringify({ sha, dirty, output, origin, time, files })};\n${source}`,
    360_000,
  );
  const report = JSON.parse(await readFile(join(output, 'browser.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  for (const file of report.screens) {
    const png = await readFile(join(output, file));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [390, 844], file);
  }
  await browser(
    `const task = await taskSpace(${report.space}); await task.finish({ keep: [] });`,
    30_000,
  );
} finally {
  gate?.latch.resolve(false);
  recognition.resolve();
  web?.httpServer.closeAllConnections();
  try {
    await web?.close();
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5 });
  }
}
