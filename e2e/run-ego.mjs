import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const external = process.env.E2E_BASE_URL ? new URL(process.env.E2E_BASE_URL) : null;
if (
  external &&
  (!['http:', 'https:'].includes(external.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(external.hostname) ||
    external.username ||
    external.password ||
    external.pathname !== '/' ||
    external.search ||
    external.hash)
) {
  throw new Error(
    'E2E_BASE_URL must be a loopback origin without credentials, path, query or fragment',
  );
}
const results = resolve(import.meta.dirname, '../test-results');
await mkdir(results, { recursive: true });
const directory = await mkdtemp(join(results, 'ego-'));
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
const child = fork(new URL('../apps/server/test/radar-fixture.mjs', import.meta.url), [], {
  execArgv: ['--import', 'tsx'],
});
const exit = once(child, 'exit');
try {
  const [message] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
    exit.then(() => {
      throw new Error('Fixture stopped before becoming ready');
    }),
  ]);
  const settings = {
    baseUrl: external?.origin ?? message.origin,
    fixture: message.origin,
    report: join(directory, 'report.json'),
    screenshot: join(directory, 'mobile.png'),
    proposalScreenshot: join(directory, 'proposal.png'),
  };
  console.log(`Browser report and screenshot: ${directory}`);
  runBrowser(`
const settings = ${JSON.stringify(settings)};
const assert = (await import('node:assert/strict')).default;
const { writeFile } = await import('node:fs/promises');
const task = await taskSpace('NextStop browser acceptance');
const page = task.page('p1');
const report = { status: 'running', space_id: task.spaceId, checks: [], screenshot: settings.screenshot };
const save = () => writeFile(settings.report, JSON.stringify(report, null, 2));
const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 10000 });
const serviceReady = () => wait(() => document.querySelector('.connection')?.textContent.includes('服务连接正常'));
const healthButton = 'loc=role:button[name*="重新检查连接"]';
const submit = 'loc=role:button[name="查找下一站"]';
const confirm = 'loc=role:button[name="确认加入行程"]';
async function pick(field, name) {
  await page.fill('#radar-' + field, name);
  const selector = '#radar-' + field + '-options [role=option]';
  await page.waitForSelector(selector);
  await page.click(selector, { label: 'Choose matching place' });
}
async function propose(minutes) {
  await page.fill('#radar-minutes', minutes);
  await page.click(submit, { label: 'Calculate walking proposal' });
}
await save();
try {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true, screenWidth:390, screenHeight:844 });
  await page.goto(settings.baseUrl);
  await serviceReady();
  assert.match(await page.title(), /下一站/);
  const state = await page.evaluate(() => ({ heading:document.querySelector('h1')?.textContent, width:innerWidth, scrollWidth:document.documentElement.scrollWidth }));
  assert.match(state.heading, /下一站/);
  assert.equal(state.width, 390);
  assert.ok(state.scrollWidth <= state.width);
  report.checks.push('mobile-shell');
  console.log(await page.snapshot());
  await page.cdp('Network.enable');
  try {
    await page.cdp('Network.setBlockedURLs', {urls:[settings.baseUrl + '/health/*']});
    await page.click(healthButton, {label:'Check failed service state'});
    await wait(() => document.querySelector('.connection')?.textContent.includes('连接失败'));
    report.checks.push('backend-error');
  } finally { await page.cdp('Network.setBlockedURLs', {urls:[]}); }
  await page.click(healthButton, {label:'Retry restored service connection'});
  await serviceReady();
  report.checks.push('retry');
  for (const failure of ['network', 'http', 'schema']) {
    try {
      await page.evaluate((failure) => {
        const original = window.fetch;
        const probe = window.healthCancellationProbe = {started:0, aborted:0};
        const path = failure === 'schema' ? '/health/capabilities' : '/health/ready';
        window.fetch = (input, init) => {
          if (input !== '/health/ready' && input !== '/health/capabilities') return original(input, init);
          probe.started++;
          if (input === path) {
            if (failure === 'network') return Promise.reject(new TypeError('Simulated connection failure'));
            return Promise.resolve(failure === 'http' ? new Response(null, {status:503}) : Response.json({}));
          }
          return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { probe.aborted++; reject(init.signal.reason); }, {once:true}));
        };
      }, failure);
      await page.click(healthButton, {label:'Check failed request cancellation'});
      await wait(() => window.healthCancellationProbe.started === 2 && window.healthCancellationProbe.aborted === 1 && document.querySelector('.connection')?.textContent.includes('连接失败'));
    } finally { await page.reload(); }
    await serviceReady();
  }
  report.checks.push('pending-request-aborted');
  // Business writes always target the isolated guest and temporary SQLite database.
  if (settings.baseUrl !== settings.fixture) await page.goto(settings.fixture);
  await page.waitForSelector('#radar-origin');
  await pick('origin', '验收起点');
  await pick('destination', '验收书店');
  await propose('5');
  await wait(() => document.querySelector('.result')?.textContent.includes('没有可行方案'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.trip li').length), 0);
  report.checks.push('empty-keeps-trip');
  await propose('90');
  await page.waitForSelector(confirm);
  await wait(() => document.querySelector('.pick')?.textContent.includes('约 7 分钟'));
  await page.evaluate(() => document.querySelector('.result')?.scrollIntoView({block:'center'}));
  await page.screenshot({path:settings.proposalScreenshot});
  // Lose a successful acknowledgement. The second explicit confirmation must replay it.
  await page.evaluate(() => {
    const original = window.fetch;
    window.confirmationKeys = [];
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (typeof input === 'string' && input.endsWith('/accept') && response.ok) {
        window.confirmationKeys.push(new Headers(init.headers).get('idempotency-key'));
        if (window.confirmationKeys.length === 1) throw new TypeError('Lost acknowledgement');
      }
      return response;
    };
  });
  await page.click(confirm, {label:'Confirm the first stop'});
  await wait(() => document.querySelector('.result [role=alert]')?.textContent.includes('确认失败'));
  await page.click(confirm, {label:'Replay the same confirmation'});
  await wait(() => document.querySelector('.trip li')?.textContent.includes('验收书店'));
  const keys = await page.evaluate(() => window.confirmationKeys);
  assert.equal(keys.length, 2); assert.ok(keys[0]); assert.equal(keys[0], keys[1]);
  report.checks.push('confirmation-replayed');
  await page.screenshot({path:settings.screenshot});
  await page.reload();
  await wait(() => document.querySelector('.trip li')?.textContent.includes('验收书店'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.trip li').length), 1);
  report.checks.push('trip-after-reload');
  await pick('origin', '验收起点'); await pick('destination', '验收书店'); await propose('90');
  await page.waitForSelector(confirm);
  // A second client of this guest legitimately changes the trip while the first tab is open.
  const competing = await page.fetch('/api/v1/radar/sessions', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({origin_id:'qa-origin',poi_id:'qa-stop',available_min:90})});
  assert.equal(competing.status,201);
  const {outcome} = JSON.parse(competing.body);
  const added = await page.fetch('/api/v1/radar/sessions/' + outcome.binding.session_id + '/accept', {method:'POST', headers:{'content-type':'application/json','idempotency-key':'other-client'},body:JSON.stringify({binding:outcome.binding,poi_id:'qa-stop'})});
  assert.equal(added.status,200);
  await page.click(confirm, {label:'Confirm the outdated proposal'});
  await wait(() => document.querySelector('.result [role=alert]')?.textContent.includes('PROPOSAL_STALE'));
  const trip = JSON.parse((await page.fetch('/api/v1/trip')).body);
  assert.equal(trip.stops.length, 2);
  report.checks.push('stale-keeps-trip');
  await page.click('loc=role:button[name="重新计算"]', {label:'Calculate a current proposal'});
  await page.waitForSelector(confirm);
  await wait(() => !document.querySelector('.result [role=alert]') && document.querySelector('.pick')?.textContent.includes('验收书店'));
  report.checks.push('stale-recalculated');
  report.status = 'passed'; await save();
  console.log(await page.snapshot());
} catch (error) { report.status = 'failed'; await save(); throw error; }
`);
  const report = JSON.parse(await readFile(settings.report, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.checks, [
    'mobile-shell',
    'backend-error',
    'retry',
    'pending-request-aborted',
    'empty-keeps-trip',
    'confirmation-replayed',
    'trip-after-reload',
    'stale-keeps-trip',
    'stale-recalculated',
  ]);
  assert.ok(Number.isInteger(report.space_id));
  runBrowser(
    `const task = await taskSpace(${JSON.stringify(report.space_id)}); await task.finish({keep:[]});`,
  );
  console.log(`ego-lite: ${report.checks.length} checks passed.`);
} finally {
  if (child.connected) child.disconnect();
  await exit;
}
assert.equal(child.exitCode, 0, 'Fixture shutdown failed');
