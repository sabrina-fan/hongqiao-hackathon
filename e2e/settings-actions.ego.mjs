// Executed by Ego Lite with fixture supplied by run-settings-actions.mjs.
const assert = (await import('node:assert/strict')).default;
const { readFile, writeFile } = await import('node:fs/promises');
const task = await taskSpace(fixture.space ?? `NextStop UI-08 ${fixture.origin}`);
const page = task.page('p1');
const report = { space: task.spaceId, checks: [], status: 'running' };
const out = (file) => `${fixture.output}/${file}`;
const shot = (name) => page.screenshot({ path: out(`${name}.png`) });
const save = () => writeFile(out('report.json'), JSON.stringify(report, null, 2));
const wait = (fn, args, timeout = 6500) => page.waitForFunction(fn, args, { timeout });
const text = (selector, value) =>
  wait(
    ([selector, value]) =>
      [...document.querySelectorAll(selector)].some(
        (node) => node.checkVisibility() && node.textContent.includes(value),
      ),
    [selector, value],
  );
const button = (name) => `loc=role:button[name="${name}"]`;
const click = (selector, label) => page.click(selector, { label });
const press = (name) => click(button(name), name);
const settings = () => click('loc=role:link[name="我的"]', 'Open personal data settings');
const summary = (name) => `css=summary:has-text("${name}")`;
const toggle = async (name, open) => {
  await click(summary(name), `Toggle settings section ${name}`);
  await wait(
    ([name, open]) =>
      [...document.querySelectorAll('.settings-row')].some(
        (row) => row.querySelector('summary strong').textContent === name && row.open === open,
      ),
    [name, open],
  );
};
async function request(path, method = 'GET', value) {
  return page.fetch(path, {
    method,
    ...(value === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }),
  });
}
async function json(path, method, value) {
  const res = await request(`/api/v1${path}`, method, value);
  assert.ok(res.ok, `${method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
}
const arm = async (path, method = 'GET') =>
  assert.equal(
    (await request(`/__settings/arm?${new URLSearchParams({ path, method })}`, 'POST')).status,
    204,
  );
const release = async (fail = false) => {
  await wait(
    async (fail) =>
      (await fetch(`/__settings/release${fail ? '?fail' : ''}`, { method: 'POST' })).ok,
    fail,
  );
};
const ready = () => text('.connection', '服务连接正常');
const loaded = () =>
  wait(() => {
    const button = document.querySelector('button.settings-link');
    return button && !button.disabled;
  });
const data = () => json('/me/data');
const notice = (value) => text('.settings-screen [role=status]', value);
const error = (value) => text('.settings-screen [role=alert]', value);
const offline = (enabled) =>
  page.cdp('Network.emulateNetworkConditions', {
    offline: enabled,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
const deleteRow = async (name) => {
  const index = await page.evaluate(
    (name) =>
      [...document.querySelectorAll('.settings-row[open] .settings-list li')].findIndex((row) =>
        row.textContent.includes(name),
      ),
    name,
  );
  assert.ok(index >= 0, `Missing deletion row ${name}`);
  await click(
    `css=.settings-row[open] .settings-list li button >> nth=${index}`,
    `Open deletion for ${name}`,
  );
};
const absent = (selector) => wait((selector) => !document.querySelector(selector), selector);
async function reloadSettings() {
  await page.reload();
  await loaded();
}

try {
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await page.goto(`${fixture.origin}/#settings`);
  await loaded();
  console.log(await page.snapshot());
  const health = 'loc=role:button[name*="重新检查连接"]';
  await arm('/health/ready');
  await click(health, 'Retry the service connection');
  await text('.connection', '正在检查连接');
  await wait(
    () => document.querySelector('.connection')?.parentElement.querySelector('button')?.disabled,
  );
  await shot('connection-loading');
  await release(true);
  await wait(() => document.querySelector('.connection.failed'));
  await shot('connection-failed');
  await click(health, 'Reconnect to local service');
  await ready();
  await loaded();
  report.checks.push('connection loading, disabled retry, failure and recovery');

  const date = { date: '2026-11-20', start: '09:00', end: '20:00', time_zone: 'Asia/Shanghai' };
  const keep = await json('/trips', 'POST', { ...date, destination: '保留旅行' });
  const owned = await json('/trips', 'POST', { ...date, destination: '待删除旅行' });
  const image = Buffer.from(await readFile(fixture.image)).toString('base64');
  const batch = await page.evaluate(async (image) => {
    const form = new FormData();
    const bytes = Uint8Array.from(atob(image), (char) => char.charCodeAt(0));
    for (const name of ['共享截图.png', '独占截图.png', '单删截图.png'])
      form.append('images', new File([bytes], name, { type: 'image/png' }));
    const res = await fetch('/api/v1/import-batches', { method: 'POST', body: form });
    if (res.status !== 202) throw new Error(`Import fixture ${res.status}`);
    return res.json();
  }, image);
  const batchPath = `/import-batches/${batch.batch_id}`;
  let reviewed;
  for (let attempt = 0; attempt < 60; attempt++) {
    reviewed = await json(batchPath);
    if (reviewed.items.every(({ kind }) => kind !== 'pending' && kind !== 'processing')) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.deepEqual(
    reviewed.items.map(({ kind }) => kind),
    ['ready', 'ready', 'ready'],
    JSON.stringify(reviewed),
  );
  const [shared, exclusive, single] = reviewed.items;
  await json(`${batchPath}/confirm`, 'POST', {
    revision: reviewed.revision,
    new_count: 1,
    selections: [shared, single].map(({ import_id }) => ({ import_id, poi_id: fixture.poi.id })),
  });
  const initial = await data();
  assert.equal(initial.trips.length, 2);
  assert.equal(initial.uploads.length, 3);
  assert(initial.uploads.every(({ trip_id }) => trip_id === owned.trip_id));
  assert.deepEqual(
    initial.places[0].sources.map(({ import_id }) => import_id).sort(),
    [shared.import_id, single.import_id].sort(),
  );

  await arm('/api/v1/me/data');
  await page.reload();
  await notice('正在读取个人数据');
  await release(true);
  await error('服务暂不可用');
  await press('重试读取');
  await loaded();
  for (const [name, content] of [
    ['本次偏好与反馈', '当前雷达会话没有可清除的反馈'],
    ['位置与隐私', '应用不会持续在后台定位'],
    ['上传记录', '共享截图.png'],
    ['旅行数据', '保留旅行'],
    ['第三方导航与数据说明', '没有自动过期清理'],
  ]) {
    await toggle(name, true);
    await text('.settings-row[open] .settings-content', content);
    await toggle(name, false);
  }
  report.checks.push('data read failure and retry, all five disclosure rows open and close');

  const exportButton = 'css=button.settings-link';
  await arm('/api/v1/me/export');
  await click(exportButton, 'Export the visitor data');
  await wait(() => document.querySelector('button.settings-link')?.disabled);
  await notice('正在导出匿名数据');
  await shot('export-loading');
  await release(true);
  await error('导出失败');
  await shot('export-failed');
  assert.deepEqual(await data(), initial);
  const downloadWaiting = page.waitForEvent('download', { timeout: 10000 });
  await click(exportButton, 'Retry the anonymous export');
  const download = await downloadWaiting;
  assert.equal(download.suggestedFilename(), 'nextstop-data.json');
  await download.saveAs(out('nextstop-data.json'));
  const exported = JSON.parse(await readFile(out('nextstop-data.json'), 'utf8'));
  assert.deepEqual(exported, initial);
  assert.deepEqual(Object.keys(exported).sort(), ['places', 'trips', 'uploads']);
  await notice('已开始下载匿名数据');
  report.checks.push('export pending, failure, retry, actual filename and JSON contract');

  await click('css=a.settings-link', 'Open place correction entry');
  await page.waitForURL(`${fixture.origin}/#library`);
  await text('main', fixture.poi.name);
  await settings();
  await loaded();
  await toggle('上传记录', true);
  const popupWaiting = page.waitForEvent('popup');
  await click('loc=role:link[name="单删截图.png"]', 'Open original source image');
  const popup = await popupWaiting;
  await popup.waitForURL(`${fixture.origin}/api/v1${batchPath}/items/${single.import_id}/image`);
  await popup.waitForLoadState();
  await popup.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0);
  await popup.close();
  report.checks.push('correction opens populated library and source image opens actual image');

  async function cancelThenDelete({ open, path, target, receipt, failure }) {
    const before = await data();
    await open();
    await text('.settings-confirm', target);
    await wait(() => {
      const layer = document.querySelector('.settings-confirm');
      const nav = document.querySelector('nav');
      return (
        layer &&
        nav &&
        [...layer.querySelectorAll('button')].every((button) => {
          const rect = button.getBoundingClientRect();
          return (
            rect.top >= 0 &&
            rect.bottom <= nav.getBoundingClientRect().top &&
            button.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            )
          );
        })
      );
    });
    await shot(`confirm-${failure ? 'image' : target.includes('待删除') ? 'trip' : 'account'}`);
    if (failure) {
      const resize = (width) =>
        page.cdp('Emulation.setDeviceMetricsOverride', {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
          screenWidth: width,
          screenHeight: 844,
        });
      await resize(320);
      await wait(() => {
        const layer = document.querySelector('.settings-confirm');
        if (!layer || innerWidth !== 320 || layer.scrollWidth > layer.clientWidth) return false;
        const [cancel, confirm] = [...layer.querySelectorAll('button')];
        return (
          [cancel, confirm].every((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.width >= 44 &&
              rect.height >= 44 &&
              rect.left >= 0 &&
              rect.right <= 320 &&
              button.contains(
                document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
              )
            );
          }) && cancel.getBoundingClientRect().right <= confirm.getBoundingClientRect().left
        );
      });
      await shot('confirm-image-320');
      await resize(390);
    }
    await press('取消');
    await absent('.settings-confirm');
    assert.deepEqual(await data(), before);
    await open();
    if (failure) {
      await arm(path, 'DELETE');
      await press('确认删除');
      await text('.settings-confirm button:disabled', '正在删除');
      await wait(() =>
        [...document.querySelectorAll('.settings-confirm button')].every(
          (button) => button.disabled,
        ),
      );
      await shot('delete-loading');
      await release(true);
      await error('删除未能确认');
      assert.deepEqual(await data(), before);
      await shot('delete-failed');
    }
    await press(failure ? '重试删除' : '确认删除');
    await notice(receipt);
  }
  await cancelThenDelete({
    open: () => deleteRow('单删截图.png'),
    path: `/api/v1/imports/${single.import_id}`,
    target: '单删截图.png',
    receipt: '已删除此截图',
    failure: true,
  });
  await reloadSettings();
  await toggle('上传记录', true);
  assert.equal((await request(`/api/v1${batchPath}/items/${single.import_id}/image`)).status, 404);
  assert.equal((await data()).places[0].sources[0].import_id, shared.import_id);
  assert.equal((await data()).places[0].sources.length, 1);
  assert.deepEqual((await data()).trips, initial.trips);
  await toggle('上传记录', false);
  await toggle('旅行数据', true);
  await cancelThenDelete({
    open: () => deleteRow('待删除旅行'),
    target: '待删除旅行',
    receipt: '已删除此旅行',
  });
  await reloadSettings();
  await toggle('旅行数据', true);
  await text('.settings-list', '保留旅行');
  const remaining = await data();
  assert.deepEqual(
    remaining.trips.map(({ trip_id }) => trip_id),
    [keep.trip_id],
  );
  assert.deepEqual(
    remaining.uploads.map(({ import_id, trip_id }) => [import_id, trip_id]),
    [[shared.import_id, null]],
  );
  assert.equal(remaining.places[0].poi_id, fixture.poi.id);
  assert.equal(
    (await request(`/api/v1${batchPath}/items/${exclusive.import_id}/image`)).status,
    404,
  );
  assert.equal((await request(`/api/v1/imports/${shared.import_id}/image`)).status, 200);
  report.checks.push('scoped cancel, pending and failure, retry, reload and retained rows/files');

  await click('loc=role:link[name="我的行程"]', 'Read retained trip online');
  await text('main', '保留旅行');
  await wait(
    () =>
      navigator.serviceWorker.controller &&
      localStorage.getItem('nextstop.offline-trip')?.includes('保留旅行'),
  );
  await offline(true);
  try {
    await page.reload();
    await text('main', '离线回读');
    await text('main', '保留旅行');
    await shot('offline-retained');
  } finally {
    await offline(false);
  }
  await page.reload();
  await settings();
  await ready();
  await loaded();
  await cancelThenDelete({
    open: () => press('删除全部匿名数据'),
    target: '此操作无法撤销',
    receipt: '已删除全部匿名数据',
  });
  await reloadSettings();
  await toggle('上传记录', true);
  await text('.settings-row[open]', '暂无上传记录');
  await toggle('旅行数据', true);
  await text('.settings-row[open]', '暂无旅行');
  assert.deepEqual(await data(), { trips: [], uploads: [], places: [] });
  await click('loc=role:link[name="我的行程"]', 'Open trip after account deletion');
  await offline(true);
  try {
    await page.reload();
    await text('main', '本机没有可回读的行程');
    await shot('offline-erased');
  } finally {
    await offline(false);
  }
  report.checks.push('account cancel and erase, refreshed empty lists and offline cache removal');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  console.log(await page.snapshot({ scope: 'full_page' }));
  throw error;
} finally {
  await save();
}
