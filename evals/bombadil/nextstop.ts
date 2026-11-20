// Bombadil property-based UI test for NextStop.
//
// Run against a deployed or local app, for example:
//   bombadil browser test --headless --time-limit=2m https://nextstop.sunwentong.cn evals/bombadil/nextstop.ts
//
// The planPath action drives one radar request per browser session, so a run
// makes at most one real model call. Domain and properties are described in
// README.md next to this file.
import { always, extract } from '@antithesishq/bombadil';
import { actions, registerCustomAction, weighted } from '@antithesishq/bombadil/browser';
import {
  clicks,
  inputs,
  navigation,
  scroll,
  waitOnce,
} from '@antithesishq/bombadil/browser/defaults/actions';

export {
  noConsoleErrors,
  noHttpErrorCodes,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from '@antithesishq/bombadil/browser/defaults/properties';

const tabs = extract((state) => {
  const links = [...state.document.querySelectorAll('#tabs a')];
  return links.map((link) => ({
    href: link.getAttribute('href'),
    active: link.getAttribute('aria-current') === 'page',
  }));
});

const hash = extract((state) => state.document.location.hash);

export const exactlyOneActiveTab = always(() => {
  const all = tabs.current ?? [];
  return all.length === 4 && all.filter((tab) => tab.active).length === 1;
});

export const activeTabMatchesHash = always(() => {
  const all = tabs.current ?? [];
  const current = hash.current || '#radar';
  return all.every((tab) => tab.active === (tab.href === current));
});

const radarForm = extract((state) => {
  const button = state.document.querySelector<HTMLButtonElement>('button.cta');
  if (!button) return null;
  const names = [...state.document.querySelectorAll('[aria-label="选点"] strong')].map(
    (node) => node.textContent?.trim() ?? '',
  );
  const custom = state.document.querySelector<HTMLInputElement>('#radar-minutes');
  const preset = [...state.document.querySelectorAll('[aria-label="常用时长"] button')].find(
    (node) => node.getAttribute('aria-pressed') === 'true',
  );
  const minutes =
    custom && !custom.closest('[hidden]')
      ? Number(custom.value)
      : Number(preset?.textContent?.trim().split(' ')[0]);
  return {
    disabled: button.disabled,
    origin: names[0] ?? '',
    destination: names[1] ?? '',
    minutes: Number.isFinite(minutes) ? minutes : null,
  };
});

export const submitOnlyWithCompleteForm = always(() => {
  const form = radarForm.current;
  if (!form || form.disabled) return true;
  return (
    form.origin !== '' &&
    form.origin !== '尚未选择出发地' &&
    form.destination !== '' &&
    form.destination !== '尚未选择目的地' &&
    form.minutes !== null &&
    form.minutes >= 1 &&
    form.minutes <= 720
  );
});

const tripStops = extract((state) => {
  return [...state.document.querySelectorAll('ol.timeline li strong')].map(
    (node) => node.textContent?.trim() ?? '',
  );
});

export const tripStopsUnique = always(() => {
  const stops = tripStops.current ?? [];
  return new Set(stops).size === stops.length;
});

const tripCount = extract((state) => {
  const text = [...state.document.querySelectorAll('.trip-card small')]
    .map((node) => node.textContent ?? '')
    .find((line) => line.includes('已加入'));
  const match = text?.match(/已加入\s*(\d+)\s*个地点/);
  return match ? Number(match[1]) : null;
});

export const tripCountMatchesList = always(() => {
  const count = tripCount.current;
  if (count === null) return true;
  return count === (tripStops.current ?? []).length;
});

const bodyText = extract((state) => state.document.body?.innerText ?? '');
const bodyHtml = extract((state) => state.document.body?.innerHTML ?? '');

export const noSecretMaterial = always(() => {
  const html = bodyHtml.current ?? '';
  return !/ZHIPU_API_KEY|ARK_API_KEY|AMAP_SERVER_KEY|COOKIE_SECRET|sk-[A-Za-z0-9]{16,}/.test(html);
});

export const noRawErrorCodes = always(
  () =>
    !/\b(?:[A-Z][A-Z0-9]*_){2,}[A-Z0-9]+\b|SESSION_REQUIRED|PROPOSAL_STALE|INTERNAL_ERROR/.test(
      bodyText.current ?? '',
    ),
);

export const noUndefinedRendering = always(() => {
  const text = bodyText.current ?? '';
  return !/(?:^|\s)(?:undefined|NaN|\[object Object\])(?:\s|$)/.test(text);
});

const viewport = extract((state) => ({
  scrollWidth: state.document.documentElement.scrollWidth,
  innerWidth: state.window.innerWidth,
}));

export const noHorizontalOverflow = always(
  () => (viewport.current?.scrollWidth ?? 0) <= (viewport.current?.innerWidth ?? 0) + 2,
);

// Keep exploring like the defaults, but never leave the origin.
export const explore = weighted([
  [1, clicks],
  [1, inputs],
  [1, scroll],
  [1, navigation],
  [1, waitOnce],
]);

// Drive the radar flow once per browser session so the expensive paths are covered.
const pickerIdle = extract(
  (state) =>
    state.document.querySelector('button.cta') !== null &&
    state.document.querySelector('dialog[open]') === null,
);
const planDone = extract((state) => {
  try {
    return state.window.sessionStorage.getItem('bombadil.planDone') === '1';
  } catch {
    return true;
  }
});

const planOnce = registerCustomAction('planOnce', async (document, window) => {
  try {
    window.sessionStorage.setItem('bombadil.planDone', '1');
  } catch {
    /* Fine: the marker only bounds spend. */
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check: () => boolean, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await sleep(100);
    }
    return false;
  }
  async function pick(label: string, query: string) {
    const button = [...document.querySelectorAll('button[aria-label]')].find(
      (node) => node.getAttribute('aria-label') === label,
    );
    if (!button) throw new Error(`picker button missing: ${label}`);
    button.click();
    const dialog = document.querySelector('dialog.place-sheet');
    if (
      !dialog ||
      !(await until(() => dialog.open && !!dialog.querySelector('input[role=combobox]')))
    )
      throw new Error(`picker dialog missing for ${label}`);
    const input = dialog.querySelector<HTMLInputElement>('input[role=combobox]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!(await until(() => !!dialog.querySelector('[role=option]'))))
      throw new Error(`no search result for ${query}`);
    dialog.querySelector<HTMLElement>('[role=option]')!.click();
    await until(() => !dialog.open);
    await sleep(100);
  }
  await pick('手动选择出发地', '拙政园');
  await pick('手动选择目的地', '平江路');
  await sleep(250);
  const submit = document.querySelector<HTMLButtonElement>('button.cta');
  if (!submit || submit.disabled) throw new Error('submit not ready');
  submit.click();
});

export const planPath = actions(() => {
  if (!pickerIdle.current || planDone.current) return [];
  return [planOnce()];
});
