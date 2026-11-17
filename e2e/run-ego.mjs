import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const base = new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173');
if (
  !['http:', 'https:'].includes(base.protocol) ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
  base.username ||
  base.password ||
  base.pathname !== '/' ||
  base.search ||
  base.hash
) {
  throw new Error(
    'E2E_BASE_URL must be a loopback origin without credentials, path, query or fragment',
  );
}
const results = resolve(import.meta.dirname, '../test-results');
await mkdir(results, { recursive: true });
const directory = await mkdtemp(join(results, 'ego-'));
const settings = {
  baseUrl: base.origin,
  report: join(directory, 'report.json'),
  screenshot: join(directory, 'mobile.png'),
};

function runBrowser(program) {
  const result = spawnSync('ego-browser', ['nodejs'], {
    input: program,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('ego-lite browser checks failed; inspect the browser and test-results');
}

console.log('Browser acceptance requires a running local app and connected ego-lite.');
console.log(`Artifacts: ${directory}`);
runBrowser(`
const settings = ${JSON.stringify(settings)};
const assert = (await import('node:assert/strict')).default;
const { writeFile } = await import('node:fs/promises');
const task = await taskSpace('NextStop browser acceptance');
const page = task.page('p1');
const report = { status: 'running', space_id: task.spaceId, checks: [], screenshot: settings.screenshot };
const save = () => writeFile(settings.report, JSON.stringify(report, null, 2));
await save();
try {
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844,
  });
  await page.goto(settings.baseUrl);
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('服务连接正常'), undefined, { timeout: 10000 });
  assert.match(await page.title(), /下一站/);
  const state = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent,
    text: document.body.textContent,
    enabled: document.querySelector('button')?.disabled === false,
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.match(state.heading, /下一站/);
  assert.match(state.text, /雷达接口：待接入/);
  assert.equal(state.enabled, true);
  assert.equal(state.width, 390);
  assert.ok(state.scrollWidth <= state.width, 'Mobile layout must not overflow horizontally');
  report.checks.push('mobile-shell');
  console.log(await page.snapshot());

  await page.cdp('Network.enable');
  try {
    await page.cdp('Network.setBlockedURLs', { urls: [settings.baseUrl + '/health/*'] });
    await page.click('button', { label: 'Check failed service state' });
    await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('连接失败'), undefined, { timeout: 10000 });
    report.checks.push('backend-error');
  } finally {
    await page.cdp('Network.setBlockedURLs', { urls: [] });
  }
  await page.click('button', { label: 'Retry restored service connection' });
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('服务连接正常'), undefined, { timeout: 10000 });
  report.checks.push('retry');
  await page.screenshot({ path: settings.screenshot });
  report.status = 'passed';
  await save();
  console.log(await page.snapshot());
} catch (error) {
  report.status = 'failed';
  await save();
  throw error;
}
`);

const report = JSON.parse(await readFile(settings.report, 'utf8'));
assert.equal(report.status, 'passed', 'Browser acceptance did not finish successfully');
assert.deepEqual(report.checks, ['mobile-shell', 'backend-error', 'retry']);
assert.ok(Number.isInteger(report.space_id), 'Browser report must identify its task space');
// Finish in a separate browser invocation after the checks have reported success.
runBrowser(
  `const task = await taskSpace(${JSON.stringify(report.space_id)}); await task.finish({ keep: [] });`,
);
console.log('ego-lite: 3 browser checks passed. Inspect mobile.png for visual confirmation.');
