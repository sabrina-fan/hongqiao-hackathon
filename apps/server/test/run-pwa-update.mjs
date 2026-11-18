// Build two production distributions, then run:
// node --import tsx apps/server/test/run-pwa-update.mjs OLD_DIST NEW_DIST [--legacy]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { createApp } from '../src/app.ts';

const [, , oldDist, newDist, mode] = process.argv;
assert(oldDist && newDist && (!mode || mode === '--legacy'));
const oldRoot = resolve(oldDist);
const newRoot = resolve(newDist);
assert.notDeepEqual(await readFile(join(oldRoot, 'sw.js')), await readFile(join(newRoot, 'sw.js')));
const results = resolve('test-results');
await mkdir(results, { recursive: true });
const output = await mkdtemp(join(results, 'pwa-update-'));
const app = createApp({
  dataDir: join(output, 'db'),
  cookieSecret: randomBytes(32).toString('hex'),
});
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript'],
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
]);
let root = oldRoot;
async function serve(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/') || pathname.startsWith('/health/')) {
    app.emit('request', req, res);
    return;
  }
  if (pathname === '/__publish' && req.method === 'POST') {
    root = newRoot;
    res.writeHead(204).end();
    return;
  }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  const bytes = await readFile(file);
  res.writeHead(200, {
    'content-type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(bytes);
}
const server = createServer((req, res) => {
  void serve(req, res).catch((error) => {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  });
});

async function scenario({ origin, output, legacy }) {
  const { default: assert } = await import('node:assert/strict');
  const task = await taskSpace(`NextStop PWA update ${origin}`);
  const page = task.page('p1');
  const wait = (predicate, arg) => page.waitForFunction(predicate, arg, { timeout: 15_000 });
  const version = (tab) => tab.evaluate(() => document.querySelector('script[type=module]').src);
  const click = (name, label) => page.click(`loc=role:button[name*="${name}"]`, { label });
  const mobile = (tab) =>
    tab.cdp('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
  const trip = '升级前保存的旅行';
  const draft = '升级期间未提交的目的地';
  const report = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
  report({ origin, space: task.spaceId, output });
  await mobile(page);
  await page.goto(`${origin}/#settings`);
  await wait(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await wait(() => !!navigator.serviceWorker.controller);
  const before = await version(page);
  const created = await page.evaluate(async (destination) => {
    const response = await fetch('/api/v1/trips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        destination,
        date: '2026-11-20',
        start: '09:00',
        end: '20:00',
        time_zone: 'Asia/Shanghai',
      }),
    });
    return response.status;
  }, trip);
  assert.equal(created, 201);
  await page.click('loc=role:link[name="我的行程"]', { label: 'Read saved trip' });
  await wait((trip) => localStorage.getItem('nextstop.offline-trip')?.includes(trip), trip);
  await click('新建旅行', 'Open new trip form');
  await page.fill('input[name=destination]', draft);
  assert.equal(await page.evaluate(() => document.querySelector('.pwa-update') === null), true);
  if (!legacy) {
    await page.cdp('Page.bringToFront');
    await wait(() => !document.hidden && navigator.onLine);
  }
  report({ phase: 'publishing' });
  await page.evaluate(async (legacy) => {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        window.pwaTestControllerChanged = true;
      },
      { once: true },
    );
    const published = await fetch('/__publish', { method: 'POST' });
    if (!published.ok) throw new Error('Unable to switch local distributions');
    if (legacy) await (await navigator.serviceWorker.getRegistration()).update();
    else document.dispatchEvent(new Event('visibilitychange'));
  }, legacy);
  await wait(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return (
      registration?.waiting?.state === 'installed' ||
      (window.pwaTestControllerChanged === true && registration?.active?.state === 'activated')
    );
  });
  const state = await page.evaluate(async () => ({
    waiting: (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? null,
    draft: document.querySelector('input[name=destination]')?.value,
  }));
  assert.equal(state.draft, draft);

  let updated;
  if (legacy || state.waiting) {
    updated = await task.newPage();
    await mobile(updated);
    await updated.goto(`${origin}/#trip`);
    const reopened = await version(updated);
    report({ waiting: state.waiting, before, reopened });
    assert.notEqual(
      reopened,
      before,
      'Ordinary reopen still serves the old bundle while the replacement waits',
    );
  } else {
    await page.waitForSelector('loc=role:link[name="打开新版"]');
    await page.screenshot({ path: `${output}/update-with-draft.png` });
    const popup = page.waitForEvent('popup');
    await page.click('loc=role:link[name="打开新版"]', { label: 'Open the updated app' });
    updated = await popup;
    await mobile(updated);
    await updated.waitForSelector('main');
    assert.notEqual(await version(updated), before);
  }
  assert.equal(
    await page.evaluate(() => document.querySelector('input[name=destination]')?.value),
    draft,
  );
  assert.equal(await version(page), before);
  await updated.cdp('Network.enable');
  const emulate = (offline) =>
    updated.cdp('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  await emulate(true);
  try {
    await updated.reload();
    await updated.waitForFunction(
      (trip) => {
        const screen = document.querySelector('main')?.textContent;
        return !navigator.onLine && screen?.includes(trip) && screen.includes('信息已过期');
      },
      trip,
      { timeout: 15_000 },
    );
    await updated.screenshot({ path: `${output}/updated-offline-trip.png` });
  } finally {
    await emulate(false);
  }
  report({ status: 'passed', before, after: await version(updated), offlineTrip: trip });
  await task.finish({ keep: [] });
}

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://pwa-${randomBytes(4).toString('hex')}.localhost:${port}`;
  const child = spawn('ego-browser', ['nodejs'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 120_000,
  });
  const closed = once(child, 'close');
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') console.error(error);
  });
  child.stdin.end(
    `const scenario = ${scenario.toString()};\nawait scenario(${JSON.stringify({ origin, output, legacy: mode === '--legacy' })});`,
  );
  const [code, signal] = await closed;
  assert.equal(code, 0, `Ego exited with ${code ?? signal}. Evidence: ${output}`);
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
