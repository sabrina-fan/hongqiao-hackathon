// Executed by Ego Lite with settings supplied by apps/server/test/run-ego-actions.mjs.
const assert = (await import('node:assert/strict')).default;
const { writeFile } = await import('node:fs/promises');
const task = await taskSpace(`NextStop actions ${new URL(settings.origin).hostname}`);
const page = task.page('p1');
const report = {
  sha: settings.sha,
  dirty: settings.dirty,
  space: task.spaceId,
  status: 'running',
  phase: 'setup',
  checks: [],
  failures: [],
  screens: [],
};
const save = () => writeFile(`${settings.output}/browser.json`, JSON.stringify(report, null, 2));
const wait = (fn, value) => page.waitForFunction(fn, value, { timeout: 10000 });
const text = async (selector, value) => {
  try {
    await wait(
      ({ selector, value }) => document.querySelector(selector)?.innerText.includes(value),
      { selector, value },
    );
  } catch (error) {
    throw new Error(`Expected ${selector} to show ${value}`, { cause: error });
  }
};
const main = (value) => text('main', value);
const alert = (selector) => text(selector, '受控失败');
const byText = (selector, name) => `css=${selector}:has-text("${name}")`;
const button = (name) => `loc=role:button[name="${name}"]`;
const click = async (selector, label) => {
  try {
    await page.click(selector, { label });
  } catch (error) {
    throw new Error(`Could not click ${label} (${selector}): ${error.message}`, { cause: error });
  }
};
const tap = (name) => click(button(name), name);
const nav = (tab) => click(`nav a[href="#${tab}"]`, `打开${tab}页面`);
const byPlace = (name) => byText('.wishlist-card', name);
const api = '/api/v1';
const library = `${api}/wishlist`;
const batches = `${api}/import-batches`;
const trips = `${api}/trips`;
const place = (id) => `${library}/amap/${id}`;
const phase = async (name) => {
  report.phase = name;
  console.log(name);
  await save();
};
const checked = (name) => report.checks.push(name);

async function fetch(path, method = 'GET') {
  const response = await page.fetch(path, { method });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response;
}
const json = async (path) => JSON.parse((await fetch(path)).body);
const arm = (method, path) =>
  fetch(`/__fixture/arm?${new URLSearchParams({ method, path })}`, 'POST');
const release = (fail = false) => fetch(`/__fixture/release${fail ? '?fail' : ''}`, 'POST');
const value = (selector) =>
  page.evaluate((selector) => document.querySelector(selector)?.value, selector);
const present = (selector) =>
  wait((selector) => Boolean(document.querySelector(selector)), selector);
const absent = (selector) => wait((selector) => !document.querySelector(selector), selector);

async function shot(name, anchor) {
  const layout = await page.evaluate((anchor) => {
    for (const id of ['immersive-translate-popup', 'immersive-translate-popup-overlay']) {
      document.getElementById(id)?.style.setProperty('display', 'none', 'important');
    }
    if (anchor)
      document.querySelector(anchor)?.scrollIntoView({ block: 'center', behavior: 'instant' });
    return [
      innerWidth,
      innerHeight,
      Math.max(
        document.documentElement.scrollWidth,
        document.querySelector('#screen')?.scrollWidth ?? 0,
      ),
    ];
  }, anchor ?? null);
  assert.deepEqual(layout, [390, 844, 390], name);
  const file = `${name}.png`;
  await page.screenshot({ path: `${settings.output}/${file}` });
  report.screens.push(file);
  await save();
}

async function pending(message, selector = 'main') {
  // Record each missing announcement so a single baseline run can exercise all recovery paths.
  const found = await page.evaluate(
    ({ selector, message }) => {
      const scope = document.querySelector(selector);
      return [...(scope?.querySelectorAll('[role="status"], [aria-live]') ?? [])].some((node) =>
        node.innerText.includes(message),
      );
    },
    { selector, message },
  );
  if (!found) {
    report.failures.push(`${report.phase} 缺少等待播报「${message}」`);
    await save();
  }
}

async function held({ message, disabled, scope, image }) {
  await page.waitForFunction(
    async () => (await (await fetch('/__fixture/state')).json()).hits > 0,
    undefined,
    { timeout: 10000 },
  );
  assert.equal((await json('/__fixture/state')).hits, 1, report.phase);
  if (disabled) await present(disabled);
  await pending(message, scope);
  if (image) await shot(image, scope);
}

async function form(fields) {
  for (const [name, input] of Object.entries(fields)) {
    const selector = `.trip-editor [name="${name}"]`;
    if (name === 'date' || name === 'start' || name === 'end') {
      // Native date/time editors use locale-dependent segments. Set their ISO form value.
      await page.evaluate(
        ({ selector, input }) => {
          document.querySelector(selector).value = input;
        },
        { selector, input },
      );
    } else await page.fill(selector, input);
    assert.equal(await value(selector), input);
  }
}

async function uploadEntry() {
  await main('我的灵感库');
  await page.waitForSelector('loc=role:button[name*="导入攻略截图"]');
  await click('loc=role:button[name*="导入攻略截图"]', '进入批量导入');
  await text('#batch-privacy', '遮挡');
}

async function reviewClick(card, label) {
  await click(`${card} ${byText('button', label).slice(4)}`, label);
}

async function batchPath() {
  return page.evaluate(
    () => document.querySelector('.batch-grid img')?.getAttribute('src').split('/items/')[0],
  );
}

try {
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    screenWidth: 390,
    screenHeight: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `Date.now = () => ${settings.time}`,
  });

  await phase('UI-03 选图、续加、移除、上传恢复');
  await page.goto(`${settings.origin}/#library`);
  await uploadEntry();
  const fileInput = 'input[aria-label="选择攻略截图"]';
  await page.setInputFiles(fileInput, settings.files.slice(0, 3));
  await main('继续添加截图');
  await page.setInputFiles(fileInput, settings.files.slice(3, 8));
  await main('已选择 8 张');
  await tap('移除 攻略-8.png');
  await main('已选择 7 张');
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.batch-filename')].map((node) => node.title),
    ),
    settings.files.slice(0, 7).map((path) => path.split('/').at(-1)),
  );
  await arm('POST', batches);
  await tap('上传并识别');
  await held({
    message: '正在上传并校验',
    disabled: `${fileInput}:disabled`,
    image: '03-upload-pending',
  });
  await release(true);
  await alert('.batch-error');
  await main('已选择 7 张');
  assert.equal((await json('/__fixture/state')).visionCalls, 0);
  await shot('03-upload-failure', '.batch-error');
  await tap('上传并识别');
  await text('.batch-progress', '处理中 1 张 · 失败 1 张');
  await shot('03-recognition-pending', '.batch-progress');
  const batch = await batchPath();
  let items = (await json(batch)).items;
  assert.equal(items.length, 7);
  assert.equal(items[6].kind, 'processing');
  assert.equal(items[3].kind, 'failed');
  await tap('移除 攻略-7.png');
  await main('本批次 6 张截图');
  await fetch('/__fixture/recognition', 'POST');
  assert.equal(
    (await json(batch)).items.some(({ import_id }) => import_id === items[6].import_id),
    false,
  );
  const failedItem = `${batch}/items/${items[3].import_id}`;
  await arm('POST', `${failedItem}/retry`);
  await tap('重试 攻略-4.png');
  await held({
    message: '正在重试识别',
    disabled: 'button[aria-label="重试 攻略-4.png"]:disabled',
    image: '03-retry-pending',
  });
  await release(true);
  await alert('.batch-error');
  assert.equal((await json(batch)).items[3].kind, 'failed');
  await tap('重试 攻略-4.png');
  await text('.batch-progress', '处理中 0 张 · 失败 0 张');
  assert.equal((await json(batch)).items[3].kind, 'ready');
  assert.equal((await json('/__fixture/state')).visionCalls, 8);
  checked('03 续选、上传失败保留、进行中移除、单张重试失败与成功');

  await phase('UI-04 恢复批次、候选、补录、跳过、删除、确认');
  await tap('返回灵感库');
  await uploadEntry();
  await tap('继续上次导入');
  await main('本批次 6 张截图');
  assert.equal(await batchPath(), batch);
  await arm('GET', library);
  await tap('查看识别结果');
  await held({ message: '正在读取核对结果', scope: '.batch-screen', image: '04-read-pending' });
  await release(true);
  await alert('.batch-error');
  await tap('刷新核对结果');
  await text('.batch-review-count', '实际新增 1 处');
  await tap('返回批次进度');
  await main('本批次 6 张截图');
  await tap('查看识别结果');
  await text('.batch-review-count', '实际新增 1 处');
  await click('.batch-matched-place > summary', '展开匹配来源');
  const urls = await page.evaluate(() =>
    [...document.querySelectorAll('.batch-matched-place article h3 + a')].map((link) =>
      link.getAttribute('href'),
    ),
  );
  assert.equal(new Set(urls).size, 2);
  for (const url of urls) assert.match((await fetch(url)).headers['content-type'], /image\/png/);
  const ambiguity = await page.evaluate(() =>
    [...document.querySelectorAll('.batch-review-card .option')]
      .filter((label) => label.innerText.includes('山塘街'))
      .map((label) => [
        label.querySelector('small')?.innerText,
        label.querySelector('input')?.checked,
      ]),
  );
  assert.deepEqual(
    ambiguity.sort(),
    [
      ['苏州山塘街 2 号', false],
      ['苏州广济路 3 号', false],
    ].sort(),
  );
  await click(byText('.batch-review-card .option', '山塘街北口'), '选择山塘街北口');
  // Use the source link's accessible name to scope a single unmatched card.
  const unmatched = '.batch-review-card:has(a[aria-label="查看原图 攻略-4.png"])';
  await click(`${unmatched} summary`, '展开未匹配补录');
  const input = `${unmatched} input[type=search]`;
  await page.fill(input, '虚构地点');
  await reviewClick(unmatched, '搜索');
  await present(`${unmatched} input[type=search]:enabled`);
  assert.equal((await json(batch)).items[3].review.match.candidates.length, 0);
  await page.fill(input, '拙政园');
  await arm('POST', `${failedItem}/search`);
  await reviewClick(unmatched, '搜索');
  await held({ message: '正在搜索地点', disabled: `${input}:disabled`, scope: '.batch-screen' });
  await release(true);
  await alert('.batch-error');
  assert.equal(await value(input), '拙政园');
  await reviewClick(unmatched, '搜索');
  await text(`${unmatched} .library-options`, '苏州东北街 178 号');
  await click(byText(`${unmatched} .option`, '拙政园'), '核对并选择拙政园');
  await text('.batch-review-count', '实际新增 3 处');
  assert.ok((await json(batch)).items[3].review.match.candidates.some(({ id }) => id === 'garden'));
  const guessed = '.batch-review-card:has(a[aria-label="查看原图 攻略-5.png"])';
  await text(guessed, '照片推测，请核对名称和地址后选择');
  await absent(`${guessed} input:checked`);
  await reviewClick(guessed, '跳过');
  await text('.batch-review-count', '已跳过 1 项');
  await reviewClick('.batch-review-card:has(a[aria-label="查看原图 攻略-6.png"])', '删除');
  await absent('.batch-review-card a[aria-label="查看原图 攻略-6.png"]');
  assert.deepEqual((await json(library)).places, []);
  assert.ok(
    (await json(batch)).items.some(({ name, kind }) => name === '攻略-5.png' && kind === 'skipped'),
  );
  await arm('POST', `${batch}/confirm`);
  const layout = await page.evaluate(() => {
    const results = document.querySelector('.batch-review-results').getBoundingClientRect();
    const confirm = document.querySelector('.batch-review-screen .cta').getBoundingClientRect();
    const tabs = document.getElementById('tabs').getBoundingClientRect();
    return {
      resultsBottom: results.bottom,
      confirmTop: confirm.top,
      confirmBottom: confirm.bottom,
      tabsTop: tabs.top,
    };
  });
  assert.ok(layout.resultsBottom <= layout.confirmTop && layout.confirmBottom <= layout.tabsTop);
  await shot('04-preview', '.batch-confirm-summary');
  const confirmBatch = () => click('loc=role:button[name*="确认并加入灵感库"]', '确认保存本批地点');
  await confirmBatch();
  await held({
    message: '正在保存收藏',
    disabled: '.batch-review-screen .cta:disabled',
    scope: '.batch-screen',
    image: '04-save-pending',
  });
  await release(true);
  await alert('.batch-error');
  await text('.batch-review-count', '实际新增 3 处');
  assert.deepEqual((await json(library)).places, []);
  await confirmBatch();
  await text('.batch-review-count', '已保存 4 张来源');
  const saved = (await json(library)).places;
  assert.deepEqual(saved.map(({ poi_id, sources }) => [poi_id, sources.length]).sort(), [
    ['garden', 1],
    ['north', 1],
    ['pingjiang', 2],
  ]);
  await tap('返回灵感库');
  await main('共 3 处');
  await uploadEntry();
  await page.setInputFiles(fileInput, settings.files.slice(8));
  await tap('上传并识别');
  await text('.batch-progress', '本批次处理结束');
  assert.notEqual(await batchPath(), batch);
  await tap('返回灵感库');
  await uploadEntry();
  await tap('手动搜索地点');
  await main('手动补录地点');
  await tap('返回灵感库');
  checked(
    '04 批次恢复、核对加载恢复、匹配原图、歧义地址、照片推测、补录空态与恢复、跳过删除、保存前后、另开批次',
  );

  await runLibraryAndDetail();
  await runTrip();
  assert.deepEqual(report.failures, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  await shot('failure').catch(() => {});
  throw error;
} finally {
  await save();
  console.log({ status: report.status, checks: report.checks, failures: report.failures });
}

async function runLibraryAndDetail() {
  await phase('UI-05 收藏加载、手动添加、搜索与筛选');
  await nav('trip');
  await main('还没有已加入的地点');
  await arm('GET', library);
  await nav('library');
  await held({ message: '正在读取收藏', scope: '.wishlist-screen', image: '05-library-loading' });
  await release(true);
  await alert('.wishlist-screen [role=alert]');
  await tap('重试读取收藏');
  await main('共 3 处');
  await tap('＋ 手动添加');
  await page.fill('#library-query', '苏州博物馆');
  await arm('POST', `${api}/imports/search`);
  await tap('搜索');
  await held({ message: '正在搜索地点', disabled: '#library-query:disabled' });
  await release(true);
  await alert('.library-screen [role=alert]');
  assert.equal(await value('#library-query'), '苏州博物馆');
  await tap('搜索');
  await text('.library-options', '苏州东北街 204 号');
  await present('.library-screen .cta:disabled');
  await click('.library-options .option', '选择博物馆地址');
  await tap('确认并加入灵感库');
  await main('已收藏 苏州博物馆');
  assert.equal((await json(place('museum'))).sources[0].kind, 'manual');
  const query = '[aria-label="搜索收藏"]';
  await page.fill(query, '广济路');
  await main('共 1 处');
  await text('.wishlist-card', '山塘街北口');
  await page.fill(query, '无此收藏');
  await main('没有符合条件的收藏');
  await page.fill(query, '');
  await main('共 4 处');
  await tap('已去');
  await main('共 0 处');
  await tap('全部');
  await main('共 4 处');
  await tap('想去');
  await tap('未安排');
  await tap('待核验');
  await main('共 4 处');
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.wishlist-filters [aria-pressed=true]')].map(
        (node) => node.innerText,
      ),
    ),
    ['想去', '未安排', '待核验'],
  );
  await tap('全部');
  await shot('05-library');
  checked('05 读取失败重试、手动添加、地址搜索、空结果及四个状态筛选');

  await phase('UI-07 读取、来源、备注、访问、纠错、移除');
  await arm('GET', place('pingjiang'));
  await click(byPlace('平江历史街区'), '打开收藏地点详情');
  await held({
    message: '正在读取地点',
    scope: '.wishlist-detail-screen',
    image: '07-detail-loading',
  });
  await release(true);
  await alert('.wishlist-detail-screen [role=alert]');
  await tap('重试读取地点');
  await main('收藏来源（2）');
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('.wishlist-sources a')].map((link) => link.getAttribute('href')),
  );
  assert.equal(new Set(links).size, 2);
  for (const link of links) assert.equal((await fetch(link)).status, 200);
  await shot('07-detail');
  await page.fill('#wishlist-note', ' 收藏验收备注 ');
  await arm('PATCH', place('pingjiang'));
  await tap('保存备注');
  await held({
    message: '正在保存备注',
    disabled: '#wishlist-note:disabled',
    scope: '.wishlist-detail-screen',
    image: '07-note-pending',
  });
  await release(true);
  await alert('.wishlist-detail-screen [role=alert]');
  assert.equal(await value('#wishlist-note'), ' 收藏验收备注 ');
  assert.equal((await json(place('pingjiang'))).note, '');
  await shot('07-note-failure', '#wishlist-note');
  await tap('保存备注');
  await main('已保存备注');
  assert.equal((await json(place('pingjiang'))).note, '收藏验收备注');
  await tap('标为已去');
  await main('已标为已去');
  assert.equal((await json(place('pingjiang'))).visit, 'visited');
  await tap('返回灵感库');
  await present(query);
  await page.fill(query, '收藏验收备注');
  await tap('已去');
  await main('共 1 处');
  await text('.wishlist-card', '平江历史街区');
  await click(byPlace('平江历史街区'), '回读备注与访问状态');
  await main('改为想去');
  assert.equal(await value('#wishlist-note'), '收藏验收备注');
  await tap('改为想去');
  await main('已标为想去');
  assert.equal((await json(place('pingjiang'))).visit, 'unvisited');
  await tap('返回灵感库');
  await present(query);
  await tap('全部');
  await page.fill(query, '');
  await click(byPlace('山塘街北口'), '打开待更正收藏');
  await main('收藏来源（1）');
  await tap('更正地图地点');
  await tap('取消更正');
  await tap('更正地图地点');
  await page.fill('#wishlist-replacement', '山塘街南口');
  await click('#wishlist-replacement-options [role=option]', '选择新的地图地址');
  await arm('POST', `${place('north')}/correction`);
  await tap('确认更正');
  await held({ message: '正在保存地点更正', scope: '.wishlist-detail-screen' });
  await release(true);
  await alert('.wishlist-detail-screen [role=alert]');
  assert.equal(await value('#wishlist-replacement'), '山塘街南口');
  assert.equal((await json(place('north'))).name, '山塘街北口');
  await tap('确认更正');
  await main('地点更正已保存');
  assert.equal((await page.fetch(place('north'))).status, 404);
  const corrected = await json(place('south'));
  assert.equal(corrected.address, '苏州山塘街 2 号');
  assert.equal(corrected.sources.length, 1);
  await tap('返回灵感库');
  await click(byPlace('苏州博物馆'), '打开待移除收藏');
  await main('收藏来源（1）');
  await tap('移除收藏');
  await tap('取消');
  assert.equal((await json(place('museum'))).poi_id, 'museum');
  await tap('移除收藏');
  await arm('DELETE', place('museum'));
  await tap('确认移除');
  await held({ message: '正在移除收藏', scope: '.wishlist-detail-screen' });
  await release(true);
  await alert('.wishlist-detail-screen [role=alert]');
  await tap('确认移除');
  await main('共 3 处');
  assert.equal((await page.fetch(place('museum'))).status, 404);
  checked('07 读取恢复、两张来源、备注保留重试、访问双向、纠错保留重试及移除取消与重试');
}

async function runTrip() {
  await phase('UI-06 读取旅行、创建、切换、编辑、固定安排');
  await arm('GET', trips);
  await click('nav a[href="#trip"]', '打开行程页面');
  await held({ message: '正在读取行程', scope: '.trip', image: '06-trip-loading' });
  await release(true);
  await alert('.trip [role=alert]');
  await tap('重新读取行程');
  await main('还没有已加入的地点');
  await tap('＋ 新建旅行');
  await form({ date: '2026-11-19', end: '19:00' });
  await tap('保存旅行');
  await main('2026-11-19');
  const first = (await json(trips)).current_trip_id;
  await tap('＋ 新建旅行');
  await form({ date: '2026-11-20', end: '19:30' });
  await arm('POST', trips);
  await tap('保存旅行');
  await held({
    message: '正在保存旅行',
    disabled: '.trip-editor button[type="submit"]:disabled',
    scope: '.trip',
    image: '06-trip-saving',
  });
  await release(true);
  await alert('.trip [role=alert]');
  assert.equal(await value('.trip-editor [name=date]'), '2026-11-20');
  assert.equal(await value('.trip-editor [name=end]'), '19:30');
  assert.equal((await json(trips)).trips.length, 1);
  await tap('保存旅行');
  await main('2026-11-20');
  const current = (await json(trips)).current_trip_id;
  assert.notEqual(current, first);
  const trip = `${trips}/${current}`;
  await arm('GET', `${trips}/${first}`);
  await click(byText('.trip-card', '2026-11-19'), '切换到另一旅行');
  await held({ message: '正在读取旅行', disabled: '.trip-card:disabled', scope: '.trip' });
  await release(true);
  await alert('.trip [role=alert]');
  await click(byText('.trip-card', '2026-11-19'), '重试切换旅行');
  await text('.trip-card[aria-pressed=true]', '2026-11-19');
  await click(byText('.trip-card', '2026-11-20'), '返回本次旅行');
  await text('.trip-card[aria-pressed=true]', '2026-11-20');
  await tap('编辑旅行');
  await form({ start: '08:30' });
  await tap('取消');
  assert.equal((await json(trip)).day.start, '09:00');
  await tap('编辑旅行');
  await form({ start: '08:45' });
  await tap('保存旅行');
  await text('.trip-card[aria-pressed=true]', '08:45–19:30');
  await tap('＋ 添加固定安排');
  await form({ name: '验收晚餐', address: '苏州临顿路 20 号', start: '17:30', end: '18:30' });
  await arm('POST', `${trip}/arrangements`);
  await tap('保存固定安排');
  await held({
    message: '正在保存固定安排',
    disabled: '.trip-editor button[type="submit"]:disabled',
    scope: '.trip',
  });
  await release(true);
  await alert('.trip [role=alert]');
  assert.equal(await value('.trip-editor [name=address]'), '苏州临顿路 20 号');
  assert.deepEqual((await json(trip)).arrangements, []);
  await tap('保存固定安排');
  await main('17:30–18:30 · 已锁定');
  await tap('编辑安排');
  await form({ end: '18:40' });
  await click('.trip-editor input[name=locked]', '取消锁定固定安排');
  await tap('保存固定安排');
  await main('17:30–18:40 · 未锁定');
  await tap('编辑安排');
  await click('.trip-editor input[name=locked]', '重新锁定固定安排');
  await tap('保存固定安排');
  await main('17:30–18:40 · 已锁定');
  const initial = await json(trip);
  assert.equal(initial.arrangements.length, 1);
  assert.equal(initial.arrangements[0].end, '18:40');
  checked('06 行程读取恢复、创建与编辑、旅行切换、固定项创建编辑与锁定');

  await phase('UI-06 草案读取、生成、重排、锁定、跳过、恢复与应用');
  const draft = `${trip}/draft`;
  await arm('GET', draft);
  await page.reload();
  await held({ message: '正在读取草案', scope: '.trip-draft' });
  await release(true);
  await main('无法读取草案');
  await tap('重试读取草案');
  await main('生成一日行程草案');
  await arm('POST', draft);
  await tap('生成一日行程草案');
  await held({
    message: '正在生成草案',
    disabled: '.draft-generate:disabled',
    scope: '.trip-draft',
    image: '06-draft-generating',
  });
  await release(true);
  await alert('.trip-draft [role=alert]');
  assert.deepEqual(await json(trip), initial);
  await tap('生成一日行程草案');
  await text('.draft-preview', '行程草案预览');
  const ordered = async () => (await json(draft)).draft.entries;
  const original = await ordered();
  assert.equal(original.length, 3);
  assert.ok(original.every(({ kind }) => kind === 'scheduled'));
  const [a, b, c] = original.map(({ name }) => name);
  const firstVisible = (name) => text('.draft-row:first-child strong', name);
  await present(`button[aria-label="上移 ${a}"]:disabled`);
  await tap(`上移 ${b}`);
  await firstVisible(b);
  assert.deepEqual(
    (await ordered()).map(({ name }) => name),
    [b, a, c],
  );
  await tap(`下移 ${b}`);
  await firstVisible(a);
  assert.deepEqual(
    (await ordered()).map(({ name }) => name),
    [a, b, c],
  );
  await tap(`锁定 ${a}`);
  await present(`button[aria-label="解锁 ${a}"]`);
  assert.equal((await ordered())[0].locked, true);
  await tap(`解锁 ${a}`);
  await present(`button[aria-label="锁定 ${a}"]`);
  assert.equal((await ordered())[0].locked, false);
  await tap(`锁定 ${a}`);
  await present(`button[aria-label="解锁 ${a}"]`);
  await tap(`跳过 ${c}`);
  await present(`button[aria-label="重新安排 ${c}"]`);
  assert.equal((await ordered()).find(({ name }) => name === c).kind, 'skipped');
  await tap(`重新安排 ${c}`);
  await present(`button[aria-label="跳过 ${c}"]`);
  assert.equal((await ordered()).find(({ name }) => name === c).kind, 'scheduled');
  await tap(`跳过 ${c}`);
  await present(`button[aria-label="重新安排 ${c}"]`);
  const before = await ordered();
  assert.deepEqual(await json(trip), initial);
  await page.reload();
  await text('.draft-preview', '已跳过');
  await present(`button[aria-label="解锁 ${a}"]`);
  assert.deepEqual(await ordered(), before);
  await shot('06-draft-preview', '.draft-preview');
  const apply = `${draft}/apply`;
  await arm('POST', apply);
  await tap('确认应用草案');
  await held({
    message: '正在应用草案',
    disabled: '.trip-draft .primary:disabled',
    scope: '.trip-draft',
    image: '06-draft-applying',
  });
  await release(true);
  await alert('.trip-draft [role=alert]');
  assert.deepEqual(await ordered(), before);
  assert.deepEqual(await json(trip), initial);
  await tap('确认应用草案');
  await main('草案已应用，固定安排已保留');
  const applied = await json(trip);
  assert.equal(applied.revision, initial.revision + 1);
  assert.deepEqual(applied.arrangements[0], initial.arrangements[0]);
  assert.deepEqual(
    applied.arrangements.slice(1).map(({ name, locked }) => [name, locked]),
    [
      [a, true],
      [b, false],
    ],
  );
  await page.reload();
  await text('.timeline', a);
  assert.deepEqual(await json(trip), applied);
  await shot('06-trip-applied', '.timeline');
  await nav('library');
  await main('共 3 处');
  const scheduled = (await json(library)).places.filter(
    ({ schedule }) => schedule === 'scheduled',
  ).length;
  assert.ok(scheduled > 0 && scheduled < 3);
  await tap('未安排');
  await main(`共 ${3 - scheduled} 处`);
  await tap('全部');
  await click('a[href="#trip"].secondary', '由灵感库进入行程');
  await text('.timeline', a);
  checked('06 草案读取、生成与应用失败重试、上下移、锁定解锁、跳过恢复、刷新与固定项保留');

  await phase('UI-06 旅行删除经设置');
  await nav('settings');
  await click(byText('summary', '旅行数据'), '展开旅行数据');
  const target = '.settings-list li';
  const index = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].findIndex((row) =>
        row.innerText.includes('2026-11-20'),
      ),
    target,
  );
  assert.ok(index >= 0);
  const remove = () => click(`${target} button >> nth=${index}`, '删除当前旅行');
  await remove();
  await text('.settings-confirm', '2026-11-20');
  await tap('取消');
  assert.equal((await json(trip)).trip_id, current);
  await remove();
  await tap('确认删除');
  await main('已删除此旅行');
  assert.equal((await page.fetch(trip)).status, 404);
  assert.equal((await json(`${trips}/${first}`)).trip_id, first);
  assert.equal((await json(library)).places.length, 3);
  checked('06 设置删除取消与确认、另一旅行和收藏保留');
}
