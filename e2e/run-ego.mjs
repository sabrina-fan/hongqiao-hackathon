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
    timeout: 240000,
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
    radarScreenshot: join(directory, 'radar.png'),
    recallScreenshot: join(directory, 'recall.png'),
    mapFallbackScreenshot: join(directory, 'recall-map-fallback.png'),
    acceptanceScreenshot: join(directory, 'acceptance.png'),
    undoScreenshot: join(directory, 'undo.png'),
    runningLockScreenshot: join(directory, 'running-lock.png'),
    fixedRecallScreenshot: join(directory, 'fixed-recall.png'),
    fixedFeedbackScreenshot: join(directory, 'fixed-feedback.png'),
    feedbackReceiptScreenshot: join(directory, 'feedback-receipt.png'),
    restoredFeedbackScreenshot: join(directory, 'settings-feedback-restored.png'),
    invalidatedFeedbackScreenshot: join(directory, 'settings-feedback-invalidated.png'),
  };
  console.log(`Browser report and screenshot: ${directory}`);
  runBrowser(`
const settings = ${JSON.stringify(settings)};
const assert = (await import('node:assert/strict')).default;
const { dirname, join } = await import('node:path');
const capture = (name) => page.screenshot({path:join(dirname(settings.report), name + '.png')});
const { writeFile } = await import('node:fs/promises');
const task = await taskSpace('NextStop radar integration ' + new URL(settings.fixture).hostname);
const page = task.page('p1');
const report = { status: 'running', space_id: task.spaceId, checks: [], screenshot: settings.screenshot };
const save = () => writeFile(settings.report, JSON.stringify(report, null, 2));
const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 10000 });
const serviceReady = () => wait(() => document.querySelector('.connection')?.textContent.includes('服务连接正常'));
const healthButton = 'loc=role:button[name*="重新检查连接"]';
const submit = 'loc=role:button[name="现在去哪"]';
const settingsLink = 'loc=role:link[name="我的"]';
const confirm = 'loc=role:button[name="确认加入行程"]';
const tripLink = 'loc=role:link[name="我的行程"]';
const radarLink = 'loc=role:link[name="机会雷达"]';
const feedbackSection = 'css=.settings-row summary:has-text("本次偏好与反馈")';
const clearFeedback = 'loc=role:button[name="清除本次反馈"]';
const feedbackMessage = (text) => wait((text) => document.querySelector('.settings-row[open] [role=status]')?.textContent.includes(text), text);
const heading = (name) => wait((name) => document.querySelector('main h1')?.textContent.trim() === name, name);
const tripHeading = () => heading('我的行程');
const tripStops = () => page.evaluate(() => [...document.querySelectorAll('.trip li')].map((stop) => stop.querySelector('strong')?.textContent.trim()));
async function checkHealth(label) {
  await page.evaluate(() => document.querySelector('.service button')?.scrollIntoView({block:'center'}));
  await page.click(healthButton, {label});
}
async function pick(field, name) {
  const label = field === 'origin' ? '手动选择出发地' : '手动选择目的地';
  await page.click('loc=role:button[name="' + label + '"]', {label:'Open the place picker'});
  await page.waitForSelector('#radar-' + field);
  await page.fill('#radar-' + field, name);
  const selector = '#radar-' + field + '-options [role=option]';
  await page.waitForSelector(selector);
  await page.click(selector, { label: 'Choose matching place' });
}
async function propose(minutes) {
  if (await page.evaluate(() => document.querySelector('#custom-time')?.hidden)) {
    await page.click('loc=role:button[name="自定义"]', {label:'Enter a custom time budget'});
  }
  await page.fill('#radar-minutes', minutes);
  await page.click(submit, { label: 'Calculate walking proposal' });
}
await save();
try {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true, screenWidth:390, screenHeight:844 });
  await page.goto(settings.baseUrl);
  await heading('现在去哪？');
  assert.match(await page.title(), /下一站/);
  const state = await page.evaluate(() => ({ heading:document.querySelector('h1')?.textContent, width:innerWidth, scrollWidth:document.documentElement.scrollWidth }));
  assert.equal(state.heading, '现在去哪？');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('nav a')].map((link) => link.hash)), ['#radar', '#library', '#trip', '#settings']);
  assert.equal(state.width, 390);
  assert.ok(state.scrollWidth <= state.width);
  report.checks.push('mobile-shell');
  console.log(await page.snapshot());
  await page.click(settingsLink, {label:'Open the service status'});
  await serviceReady();
  await page.cdp('Network.enable');
  try {
    await page.cdp('Network.setBlockedURLs', {urls:[settings.baseUrl + '/health/*']});
    await checkHealth('Check failed service state');
    await wait(() => document.querySelector('.connection')?.textContent.includes('连接失败'));
    report.checks.push('backend-error');
  } finally { await page.cdp('Network.setBlockedURLs', {urls:[]}); }
  await checkHealth('Retry restored service connection');
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
      await checkHealth('Check failed request cancellation');
      await wait(() => window.healthCancellationProbe.started === 2 && window.healthCancellationProbe.aborted === 1 && document.querySelector('.connection')?.textContent.includes('连接失败'));
    } finally { await page.reload(); }
    await serviceReady();
  }
  report.checks.push('pending-request-aborted');
  // Business writes always target the isolated guest and temporary SQLite database.
  if (settings.baseUrl !== settings.fixture) await page.goto(settings.fixture);
  await page.click(radarLink, {label:'Open the radar form'});
  await page.waitForSelector('.radar-form');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.radar-form p')].some((line) => line.textContent.trim() === '出行方式：步行')), true);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.radar-preference-row .chip')].every((chip) => chip instanceof HTMLButtonElement)), true);
  await page.click('loc=role:button[name*="查看上次雷达结果"]', {label:'Check for saved radar history'});
  await wait(() => document.querySelector('.radar-history-link [role=status]')?.textContent.includes('还没有保存的雷达结果'));
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (typeof input === 'string' && input.startsWith('/api/v1/places?')) {
        await new Promise((resolve) => { window.releaseSearch = resolve; });
        window.fetch = original;
      }
      return original(input, init);
    };
  });
  await page.click('loc=role:button[name="手动选择出发地"]', {label:'Open the origin search'});
  await page.fill('#radar-origin', '验收起点');
  await wait(() => document.querySelector('dialog[open] .hints')?.textContent.includes('搜索中') && typeof window.releaseSearch === 'function');
  await capture('search-pending');
  await page.evaluate(() => window.releaseSearch());
  await page.click('#radar-origin-options [role=option]', {label:'Select the loaded origin'});
  await pick('destination', '验收书店');
  await page.click('loc=role:link[name="灵感库"]', {label:'Open the inspiration library'});
  await heading('我的灵感库');
  await wait(() => document.querySelector('main')?.textContent.includes('还没有收藏'));
  await page.click('loc=role:link[name="我的"]', {label:'Open the settings page'});
  await heading('我的');
  await wait(() => document.querySelector('.settings-screen')?.textContent.includes('导出匿名数据'));
  await page.click(feedbackSection, {label:'Read the empty feedback state'});
  await feedbackMessage('当前雷达会话没有可清除的反馈。');
  report.checks.push('settings-without-feedback');
  await page.click(radarLink, {label:'Resume the selected places'});
  await heading('现在去哪？');
  await wait(() => [...document.querySelectorAll('.place-row strong')].map((place) => place.textContent.trim()).join('|') === '验收起点|验收书店');
  await page.click('loc=role:button[name="75 分钟"]', {label:'Select a walking time budget'});
  const timeTargets = await page.evaluate(() => [...document.querySelectorAll('[aria-label="常用时长"] button')].map((button) => {
    const {width, height} = button.getBoundingClientRect();
    return {width, height};
  }));
  assert.equal(timeTargets.length, 4);
  assert.ok(timeTargets.every(({width, height}) => width >= 44 && height >= 44), 'Time choices must have 44 × 44 CSS px touch targets');
  await page.screenshot({path:settings.radarScreenshot});
  report.checks.push('capability-pages-and-radar-return');
  await propose('5');
  await wait(() => document.querySelector('.result')?.textContent.includes('没有可行方案'));
  await page.click(tripLink, {label:'Open the empty itinerary'});
  await tripHeading();
  await wait(() => document.querySelector('.trip')?.textContent.includes('还没有已加入的地点'));
  assert.deepEqual(await tripStops(), []);
  report.checks.push('empty-keeps-trip');
  await page.click(radarLink, {label:'Return to the radar result'});
  await wait(() => document.querySelector('.result')?.textContent.includes('没有可行方案'));
  await page.click('loc=role:button[name="修改条件"]', {label:'Edit the radar conditions'});
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.radar-history-link [role=status]'))), false);
  report.checks.push('empty-history-note-cleared-after-calculation');
  await propose('90');
  await page.waitForSelector(confirm);
  await wait(() => document.querySelector('.pick')?.textContent.includes('约 7 分钟'));
  await heading('推荐结果');
  await page.screenshot({path:settings.proposalScreenshot});
  await page.click(confirm, {label:'Add an existing itinerary stop'});
  await wait(() => document.querySelector('.radar-acceptance [role=status]')?.textContent.includes('已加入行程：验收书店'));
  const existingStops = JSON.parse((await page.fetch('/api/v1/trip')).body).stops;
  assert.deepEqual(existingStops.map(({poi_id}) => poi_id), ['qa-stop']);

  const edit = 'loc=role:button[name="修改条件"]';
  await page.click(edit, {label:'Open the recall conditions'});
  await page.click('loc=role:button[name="联合搜索"]', {label:'Search saved and nearby places'});
  await propose('75');
  await wait(() => document.querySelectorAll('.radar-map-pin').length === 3);
  for (const name of ['验收公园', '验收书店', '验收茶馆']) {
    await page.click('css=.radar-card-choice:has-text("' + name + '")', {label:'Select a recommendation card'});
    await wait((name) => document.querySelector('.radar-map-pin[aria-pressed=true]')?.getAttribute('aria-label') === '地图标记 ' + name, name);
  }
  await page.click('loc=role:button[name="地图标记 验收公园"]', {label:'Select the park marker'});
  await wait(() => document.querySelector('.radar-card-choice[aria-pressed=true] strong')?.textContent === '验收公园');
  await page.click('loc=role:button[name="地图标记 验收茶馆"]', {label:'Select the tea house alternative'});
  await wait(() => document.querySelector('.radar-card-choice[aria-pressed=true]')?.textContent.includes('备选') && document.querySelector('.pick h3')?.textContent === '验收茶馆');
  await page.screenshot({path:settings.recallScreenshot});
  report.checks.push('three-cards-and-map-selection');

  // Lose the alternative's successful acknowledgement and replay the same selection.

  await page.evaluate(() => {
    const original = window.fetch;
    window.confirmationKeys = [];
    window.fetch = async (input, init) => {
      if (typeof input === 'string' && input.endsWith('/accept') && !window.confirmationKeys.length) {
        await new Promise((resolve) => { window.releaseConfirmation = resolve; });
      }
      const response = await original(input, init);
      if (typeof input === 'string' && input.endsWith('/accept') && response.ok) {
        window.confirmationKeys.push(new Headers(init.headers).get('idempotency-key'));
        if (window.confirmationKeys.length === 1) throw new TypeError('Lost acknowledgement');
      }
      return response;
    };
  });
  await page.click(confirm, {label:'Confirm the selected alternative'});
  await wait(() => document.querySelector('.pick button.primary')?.disabled && document.querySelector('.pick button.primary')?.textContent.includes('正在确认') && typeof window.releaseConfirmation === 'function');
  await capture('confirmation-pending');
  await page.evaluate(() => window.releaseConfirmation());
  await wait(() => document.querySelector('.result [role=alert]')?.textContent.includes('确认失败'));
  await page.click(confirm, {label:'Replay the same confirmation'});
  await wait(() => document.querySelector('.radar-acceptance [role=status]')?.textContent.includes('已加入行程：验收茶馆'));
  assert.ok(await page.evaluate(() => Boolean(document.querySelector('nav a[href="#trip"]'))), '确认成功后，底部导航应提供「我的行程」入口');
  await page.click(tripLink, {label:'Open the saved itinerary'});
  await tripHeading();
  await page.waitForSelector('.trip li');
  assert.deepEqual(await tripStops(), ['验收书店', '验收茶馆']);
  assert.equal(await page.evaluate(() => document.querySelector('nav [aria-current="page"]')?.hash), '#trip');
  const keys = await page.evaluate(() => window.confirmationKeys);
  assert.equal(keys.length, 2); assert.ok(keys[0]); assert.equal(keys[0], keys[1]);
  report.checks.push('alternative-confirmation-replayed', 'trip-via-bottom-navigation');
  await page.reload();
  await tripHeading();
  await page.waitForSelector('.trip li');
  assert.deepEqual(await tripStops(), ['验收书店', '验收茶馆']);
  await page.screenshot({path:settings.screenshot});
  report.checks.push('trip-after-reload');
  await page.click(radarLink, {label:'Recover the confirmed alternative'});
  await wait(() => document.querySelector('.radar-acceptance [role=status]')?.textContent.includes('已加入行程：验收茶馆'));
  const links = await page.evaluate(() => [...document.querySelectorAll('.radar-acceptance a[target="_blank"]')].map(a => a.href));
  assert.equal(links.length, 2);
  for (const [index, href] of links.entries()) {
    const target = new URL(href);
    assert.equal(target.origin, 'https://uri.amap.com');
    assert.equal(target.pathname, '/navigation');
    assert.equal(target.searchParams.get('to'), '120.098,31.12,验收茶馆');
    assert.equal(target.searchParams.get('mode'), 'walk');
    assert.equal(target.searchParams.get('callnative'), index === 0 ? '1' : '0');
  }
  // Use a controlled clipboard so the user's real clipboard is untouched.
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
    value: async (value) => { window.copiedAddress = value; },
  }));
  await page.click('loc=role:button[name="复制地址"]', {label:'Copy the confirmed address'});
  assert.equal(await page.evaluate(() => window.copiedAddress), '测试街四号');
  await page.screenshot({path:settings.acceptanceScreenshot});
  report.checks.push('navigation-links-and-copy-after-reload');
  await page.evaluate(() => {
    const original = window.fetch;
    let attempts = 0;
    window.fetch = async (input, init) => {
      if (typeof input === 'string' && input.endsWith('/acceptance/undo')) {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Undo unavailable');
        const result = await original(input, init);
        if (attempts === 2 && result.ok) throw new TypeError('Lost undo acknowledgement');
        return result;
      }
      return original(input, init);
    };
  });
  await page.click('loc=role:button[name="撤销本次加入"]', {label:'Try undo while disconnected'});
  await wait(() => document.querySelector('.radar-acceptance [role=alert]')?.textContent.includes('撤销未能确认'));
  assert.deepEqual(JSON.parse((await page.fetch('/api/v1/trip')).body).stops.map(({poi_id}) => poi_id), ['qa-stop', 'qa-tea']);
  await page.click('loc=role:button[name="重试撤销"]', {label:'Retry undo and recover receipt'});
  await wait(() => document.querySelector('.radar-acceptance [role=status]')?.textContent.includes('已撤销本次加入：验收茶馆'));
  await page.reload();
  await wait(() => document.querySelector('.radar-acceptance [role=status]')?.textContent.includes('已撤销本次加入：验收茶馆'));
  assert.deepEqual(JSON.parse((await page.fetch('/api/v1/trip')).body).stops, existingStops);
  await page.screenshot({path:settings.undoScreenshot});
  report.checks.push('targeted-undo-failure-retry-and-recovery');
  await page.click(edit, {label:'Return to radar conditions'});
  await pick('origin', '验收起点');
  await pick('destination', '验收书店');
  await propose('90');
  await page.waitForSelector(confirm);
  // A second client of this guest legitimately changes the trip while the first tab is open.
  const competing = await page.fetch('/api/v1/radar/sessions', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({origin_id:'qa-origin',poi_id:'qa-park',available_min:90})});
  assert.equal(competing.status,201);
  const {outcome} = JSON.parse(competing.body);
  const added = await page.fetch('/api/v1/radar/sessions/' + outcome.binding.session_id + '/accept', {method:'POST', headers:{'content-type':'application/json','idempotency-key':'other-client'},body:JSON.stringify({binding:outcome.binding,poi_id:'qa-park'})});
  assert.equal(added.status,200);
  await page.click(confirm, {label:'Confirm the outdated proposal'});
  await wait(() => document.querySelector('.result [role=alert]')?.textContent.includes('PROPOSAL_STALE'));
  const trip = JSON.parse((await page.fetch('/api/v1/trip')).body);
  assert.deepEqual(trip.stops.map(({poi_id}) => poi_id), ['qa-stop', 'qa-park']);
  report.checks.push('stale-keeps-trip');
  await page.click('loc=role:button[name="重新计算"]', {label:'Calculate a current proposal'});
  await page.waitForSelector(confirm);
  await wait(() => !document.querySelector('.result [role=alert]') && document.querySelector('.pick')?.textContent.includes('验收书店'));
  report.checks.push('stale-recalculated');
  await page.click(edit, {label:'Open the recall conditions'});
  await page.click('loc=role:button[name="联合搜索"]', {label:'Search saved and nearby places'});
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (input !== '/api/v1/radar/sessions' || !response.ok) return response;
      const view = await response.json();
      for (const candidate of view.candidates) delete candidate.markers;
      return Response.json(view, {status:201});
    };
  });
  await propose('75');
  await wait(() => document.querySelector('.result')?.textContent.includes('地图预览暂不可用'));
  await page.click('css=.radar-card-choice >> nth=1', {label:'Select an alternative without map'});
  await wait(() => document.querySelector('.radar-card-choice[aria-pressed=true] strong')?.textContent === document.querySelector('.pick h3')?.textContent && !document.querySelector('.pick button.primary')?.disabled);
  await page.screenshot({path:settings.mapFallbackScreenshot});
  report.checks.push('map-failure-keeps-cards-actionable');
  await page.click(edit, {label:'Open the time window'});
  await propose('5');
  await wait(() => document.querySelector('.result')?.textContent.includes('建议不绕路'));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.result button')].some((button) => button.textContent.includes('确认加入行程'))), false);
  report.checks.push('tc-18-no-detour');

  await page.click(edit, {label:'Return to the radar form'});
  await page.reload(); // Restore the real fetch before testing fixed-route markers.
  const jsonPost = async (path, body, status = 200) => {
    const response = await page.fetch('/api/v1' + path, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body),
    });
    assert.equal(response.status, status, response.body);
    return JSON.parse(response.body);
  };
  // Use a zone with enough room on the current day to test both locks without crossing midnight.
  const minute = 60_000;
  const startMinute = Math.floor(Date.now() / minute) * minute;
  const chinaHour = (new Date(startMinute).getUTCHours() + 8) % 24;
  const time_zone = chinaHour >= 2 && chinaHour < 21 ? 'Asia/Shanghai' : 'UTC';
  const wall = new Intl.DateTimeFormat('sv-SE', {
    timeZone:time_zone, dateStyle:'short', timeStyle:'short',
  });
  const timeAt = (offset) => wall.format(startMinute + offset * minute).slice(-5);
  let plannedTrip = await jsonPost('/trips', {
    destination:'苏州', date:wall.format(startMinute).slice(0,10), time_zone,
    start:timeAt(-30), end:timeAt(130),
  }, 201);
  const arrangements = '/trips/' + plannedTrip.trip_id + '/arrangements';
  const saveLock = async (arrangement, id) => {
    plannedTrip = await jsonPost(arrangements + (id ? '/' + id : ''), {
      revision:plannedTrip.revision, arrangement:{...arrangement, locked:true},
    });
  };
  const currentLock = {name:'验收晚餐', start:timeAt(-10), end:timeAt(20), address:'晚餐地址'};
  const nextLock = {name:'验收演出', start:timeAt(78), end:timeAt(110), address:''};
  await saveLock(currentLock);
  await saveLock(nextLock);
  await page.click(settingsLink, {label:'Leave the radar to refresh'});
  await page.click(radarLink, {label:'Read the new locked schedule'});
  await page.waitForSelector('.radar-form');
  await pick('origin', '验收起点');
  const skip = 'loc=role:checkbox[name="本次不使用这个固定安排"]';
  const disabled = () => document.querySelector('button.cta[type=submit]')?.disabled;
  await wait(() => document.querySelector('#running-lock-heading + [role=status]')?.textContent.includes('验收晚餐进行中') && document.querySelector('.radar-form .locked[href="#trip"]')?.textContent.includes('验收演出'));
  assert.equal(await page.evaluate(disabled), true);
  await page.click(skip, {label:'Try skipping the locationless next lock'});
  assert.equal(await page.evaluate(disabled), true);
  await page.screenshot({path:settings.runningLockScreenshot});
  report.checks.push('running-lock-blocks-default-recall');

  // Make the current lock end at the start of this minute. HTTP tests cover the exact clock boundary.
  await saveLock({...currentLock, end:timeAt(0)}, plannedTrip.arrangements[0].arrangement_id);
  await page.click('loc=role:button[name="检查时段"]', {label:'Recheck the running lock'});
  await wait(() => !document.querySelector('#running-lock-heading') && document.querySelector('button.cta[type=submit]')?.disabled === false);
  await page.click(skip, {label:'Require the next lock location again'});
  assert.equal(await page.evaluate(disabled), true);
  await page.click(skip, {label:'Continue without the missing address'});
  await page.click('loc=role:button[name="105 分钟"]', {label:'Set the recall time budget'});
  await page.click(submit, {label:'Calculate without the missing address'});
  await page.waitForSelector(confirm);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.pick .times div').length), 2);
  report.checks.push('locationless-lock-explicit-recall-fallback');

  await saveLock({...nextLock, address:'验收演出地址'}, plannedTrip.arrangements[1].arrangement_id);
  await page.click(edit, {label:'Open the radar conditions'});
  await page.click(settingsLink, {label:'Leave the radar to refresh'});
  await page.click(radarLink, {label:'Load the verified next address'});
  await wait(() => document.querySelector('.radar-form .locked[href="#trip"]')?.textContent.includes('验收演出') && !document.querySelector('.radar-form input[type=checkbox]'));
  await page.click(submit, {label:'Calculate with the verified next address'});
  await page.waitForSelector(confirm);
  await wait(() => document.querySelectorAll('.radar-map-pin').length === 3 && [...document.querySelectorAll('.radar-map-anchor')].some((anchor) => anchor.textContent === '下一站'));
  assert.match(await page.evaluate(() => document.querySelector('.result .context')?.textContent), /验收演出.*按固定截止/s);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.pick .times div')].map((segment) => [...segment.children].map((item) => item.textContent))), [
    ['步行前往', '约 7 分钟'], ['建议停留', '约 40 分钟'], ['下一站', '15 分钟'], ['缓冲', '10 分钟'],
  ]);
  assert.match(await page.evaluate(() => document.querySelector('.pick-bottom')?.textContent), /共约 72 分钟/);
  await page.evaluate(() => document.querySelector('.pick .times')?.scrollIntoView({block:'center'}));
  await page.screenshot({path:settings.fixedRecallScreenshot});
  report.checks.push('default-recall-after-lock-uses-next-stop-and-segments');

  const fixedHint = await page.evaluate(() => document.querySelector('.result .context')?.textContent);
  const previous = await page.evaluate(() => document.querySelector('.pick h3')?.textContent);
  const actions = await page.evaluate(() =>
    [...document.querySelectorAll('.pick .actions > button')].map((button) => {
      const { height, left, right } = button.getBoundingClientRect();
      return { height, left, right };
    }),
  );
  assert.equal(actions.length, 2);
  assert.ok(actions.every(({height, left, right}) => height >= 44 && left >= 0 && right <= 390));
  assert.ok(actions[0].right <= actions[1].left);
  await page.click('loc=role:button[name="换一个"]', {label:'Open the feedback choices'});
  await page.click('loc=role:button[name="不感兴趣"]', {label:'Choose a different experience'});
  await wait((previous) => document.querySelector('.radar-feedback-note')?.textContent.includes('不感兴趣') && document.querySelector('.pick h3')?.textContent !== previous && document.querySelectorAll('.radar-map-pin').length === 2, previous);
  const reranked = await page.evaluate(() => document.querySelector('.pick h3')?.textContent);
  await page.reload();
  await wait((name) => document.querySelector('.pick h3')?.textContent === name && document.querySelector('.radar-feedback-note')?.textContent.includes('不感兴趣'), reranked);
  assert.equal(await page.evaluate(() => document.querySelector('.result .context')?.textContent), fixedHint);
  await page.screenshot({path:settings.fixedFeedbackScreenshot});
  report.checks.push('fixed-feedback-rerank-and-reload');

  await page.click(settingsLink, {label:'Open settings with active feedback'});
  await page.click(feedbackSection, {label:'Read the current session feedback'});
  await feedbackMessage('不感兴趣');
  await page.click(clearFeedback, {label:'Clear feedback while evidence is fresh'});
  await feedbackMessage('已清除本次反馈，并按原条件重新筛选。');
  await page.screenshot({path:settings.restoredFeedbackScreenshot});
  await page.click(radarLink, {label:'Read the restored result'});
  await wait((name) => document.querySelector('.pick h3')?.textContent === name && !document.querySelector('.radar-feedback-note'), previous);
  await page.reload();
  await wait((name) => document.querySelector('.pick h3')?.textContent === name && !document.querySelector('.radar-feedback-note'), previous);
  report.checks.push('settings-clears-fresh-feedback-and-restores-recommendation');

  await page.click('loc=role:button[name="换一个"]', {label:'Reopen the feedback choices'});
  await page.click('loc=role:button[name="不感兴趣"]', {label:'Rerank before accepting'});
  await wait((name) => document.querySelector('.pick h3')?.textContent === name && document.querySelector('.radar-feedback-note')?.textContent.includes('不感兴趣'), reranked);
  const receiptShows = (status) => wait((text) => document.querySelector('.radar-acceptance [role=status]')?.textContent.includes(text), status + '：' + reranked);
  await page.click(confirm, {label:'Confirm the reranked choice'});
  await receiptShows('已加入行程');
  await page.reload();
  await receiptShows('已加入行程');
  await page.screenshot({path:settings.feedbackReceiptScreenshot});
  const acceptedSession = await page.evaluate(() => sessionStorage.getItem('nextstop.radar-session'));
  assert.ok(acceptedSession);
  await page.click(settingsLink, {label:'Open settings after the trip changed'});
  await page.click(feedbackSection, {label:'Read feedback from the invalidated result'});
  await feedbackMessage('不感兴趣');
  await page.click(clearFeedback, {label:'Clear feedback after the trip made the result stale'});
  await feedbackMessage('已清除本次反馈。上次结果已失效，请重新计算推荐。');
  await page.screenshot({path:settings.invalidatedFeedbackScreenshot});
  const removedResult = await page.fetch('/api/v1/radar/sessions/' + acceptedSession);
  assert.equal(removedResult.status, 404);
  await page.click(radarLink, {label:'Recover the receipt without replaying the invalidated recommendation'});
  await receiptShows('已加入行程');
  report.checks.push('settings-clears-stale-feedback-and-preserves-receipt');
  await page.click('loc=role:button[name="撤销本次加入"]', {label:'Undo the reranked choice'});
  await receiptShows('已撤销本次加入');
  await page.reload();
  await receiptShows('已撤销本次加入');
  const afterUndo = JSON.parse((await page.fetch('/api/v1/trips/' + plannedTrip.trip_id)).body);
  assert.deepEqual(afterUndo.stops, []);
  assert.deepEqual(afterUndo.arrangements, plannedTrip.arrangements);
  report.checks.push('fixed-feedback-receipt-and-targeted-undo');

  await page.click(radarLink, {label:'Return to the radar after undo'});
  await page.goto(settings.fixture + '/#radar');
  await page.evaluate(async () => {
    sessionStorage.removeItem('nextstop.radar-session');
  });
  await page.reload();
  await heading('现在去哪？');
  await page.cdp('Browser.setPermission', {permission:{name:'geolocation'}, setting:'denied', origin:settings.fixture});
  const locate = 'loc=role:button[name="使用当前位置"]';
  await page.evaluate(() => {
    const gps = navigator.geolocation;
    const request = gps.getCurrentPosition.bind(gps);
    gps.getCurrentPosition = (...args) => {
      gps.getCurrentPosition = request;
      window.releaseLocation = () => request(...args);
    };
  });
  await page.click(locate, {label:'Request a denied location'});
  await wait(() => document.querySelector('.radar-form')?.textContent.includes('正在定位') && typeof window.releaseLocation === 'function');
  assert.equal(await page.evaluate(() => document.querySelector('.home-action button').disabled), true);
  await capture('location-pending');
  await page.evaluate(() => window.releaseLocation());
  await wait(() => document.querySelector('.radar-form')?.textContent.includes('定位权限未开启'));
  await page.cdp('Browser.setPermission', {permission:{name:'geolocation'}, setting:'granted', origin:settings.fixture});
  await page.cdp('Emulation.setGeolocationOverride', {latitude:31.10, longitude:120.10, accuracy:12});
  await page.click(locate, {label:'Use fixture GPS coordinates'});
  await wait(() => document.querySelector('.place-row strong')?.textContent.includes('我的当前位置'));
  report.checks.push('geolocation-denied-and-granted');
  await pick('destination', '验收茶馆');
  await page.evaluate(() => {
    const fetchRadar = window.fetch;
    window.walkRequests = [];
    window.fetch = (input, init) => {
      if (input === '/api/v1/radar/sessions' && init?.method === 'POST') {
        window.walkRequests.push(JSON.parse(init.body));
        if (window.walkRequests.length === 1) {
          return new Promise((resolve) => {
            window.releaseCalculation = () => resolve(Response.json({error:{code:'MAP_UNAVAILABLE',message:'地图服务暂不可用'}}, {status:502}));
          });
        }
      }
      return fetchRadar(input, init);
    };
  });
  const shortWalk = 'loc=role:button[name="轻松步行"]';
  const pressed = () => page.evaluate(() => document.querySelector('.radar-preference-row button').getAttribute('aria-pressed'));
  assert.equal(await pressed(), 'false');
  await page.click(shortWalk, {label:'Enable the short walking preference'});
  assert.equal(await pressed(), 'true');
  await propose('105');
  await wait(() => document.querySelector('.home-action button')?.matches(':disabled') && document.querySelector('.home-action button')?.textContent.includes('正在计算') && typeof window.releaseCalculation === 'function');
  await capture('calculation-pending');
  await page.evaluate(() => window.releaseCalculation());
  await wait(() => document.querySelector('[role=alert]')?.textContent.includes('重试计算'));
  await capture('supplier-failure');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('重试计算'))?.scrollIntoView({block:'center'}));
  await page.click('loc=role:button[name="重试计算"]', {label:'Retry calculation after the supplier failure'});
  await wait(() => document.querySelector('.result')?.textContent.includes('没有可行方案'));
  await capture('no-feasible-option');
  await page.click(edit, {label:'Return to the walking preference'});
  await page.click(shortWalk, {label:'Disable the short walking preference'});
  assert.equal(await pressed(), 'false');
  await propose('105');
  await wait(() => document.querySelector('.pick h3')?.textContent === '验收茶馆');
  const walkRequests = await page.evaluate(() => window.walkRequests);
  assert.equal(walkRequests.length, 3);
  assert.deepEqual(walkRequests[0], walkRequests[1]);
  const [, {preference, ...limited}, unrestricted] = walkRequests;
  assert.equal(preference, 'short_walk');
  assert.equal(limited.position.system, 'wgs84');
  assert.deepEqual(limited, unrestricted);
  report.checks.push('short-walk-changes-request-and-result');
  await page.click(edit, {label:'Return to the radar form'});
  await page.click('loc=role:button[name*="查看上次雷达结果"]', {label:'Open saved radar history'});
  await heading('上次雷达结果');
  assert.equal(await page.evaluate(() => document.querySelector('.pick button.primary')?.disabled ?? true), true);
  await page.click('loc=role:button[name="使用上次条件"]', {label:'Restore the saved conditions'});
  await pick('origin', '验收起点');
  await page.click('loc=role:button[name="联合搜索"]', {label:'Search nearby and saved places'});
  for (const [label, reason] of [['太远','too_far'], ['太贵','too_expensive'], ['不想走路','less_walking']]) {
    await propose('105');
    await page.waitForSelector('.pick .actions > button.secondary');
    await page.evaluate(() => document.querySelector('.pick .actions')?.scrollIntoView({block:'center'}));
    const swap = 'loc=role:button[name="换一个"]';
    await page.click(swap, {label:'Open the reason sheet'});
    await page.click('loc=role:button[name="取消"]', {label:'Dismiss the reason sheet'});
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('.radar-feedback-note'))), false);
    await page.click(swap, {label:'Reopen the reason sheet'});
    await page.click('loc=role:button[name="' + label + '"]', {label:'Submit the selected reason'});
    await wait((label) => document.querySelector('.radar-feedback-note')?.textContent.includes(label), label);
    await capture('feedback-' + reason);
    await page.click(edit, {label:'Start a fresh calculation'});
  }
  report.checks.push('saved-history-and-all-feedback-reasons');

  report.status = 'passed'; await save();
  console.log(await page.snapshot());
} catch (error) { report.status = 'failed'; report.error = String(error); await save(); throw error; }
`);
  const report = JSON.parse(await readFile(settings.report, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.checks, [
    'mobile-shell',
    'backend-error',
    'retry',
    'pending-request-aborted',
    'settings-without-feedback',
    'capability-pages-and-radar-return',
    'empty-keeps-trip',
    'empty-history-note-cleared-after-calculation',
    'three-cards-and-map-selection',
    'alternative-confirmation-replayed',
    'trip-via-bottom-navigation',
    'trip-after-reload',
    'navigation-links-and-copy-after-reload',
    'targeted-undo-failure-retry-and-recovery',
    'stale-keeps-trip',
    'stale-recalculated',
    'map-failure-keeps-cards-actionable',
    'tc-18-no-detour',
    'running-lock-blocks-default-recall',
    'locationless-lock-explicit-recall-fallback',
    'default-recall-after-lock-uses-next-stop-and-segments',
    'fixed-feedback-rerank-and-reload',
    'settings-clears-fresh-feedback-and-restores-recommendation',
    'settings-clears-stale-feedback-and-preserves-receipt',
    'fixed-feedback-receipt-and-targeted-undo',
    'geolocation-denied-and-granted',
    'short-walk-changes-request-and-result',
    'saved-history-and-all-feedback-reasons',
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
