import type {
  FixedStop,
  PlaceOption,
  RadarCandidate,
  RadarContext,
  RadarOutcome,
  RadarView,
} from '@nextstop/core';
import './radar-context.css';
import './radar-visual.css';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { PlaceField } from './PlaceField.js';

export function Icon({ children }: { children: string }) {
  return (
    <span className="icon" aria-hidden="true">
      {children}
    </span>
  );
}

type PlaceKind = 'origin' | 'destination';
const placeLabels: Record<PlaceKind, string> = { origin: '当前位置', destination: '候选目的地' };
const timePresets = [45, 75, 105];

export function RadarForm({
  places,
  location,
  fixed,
  shortWalk,
  onShortWalk,
  minutes,
  busy,
  canSubmit,
  onPlace,
  onMinutes,
  onSubmit,
  onSessionExpired,
}: {
  places: Record<PlaceKind, PlaceOption | null>;
  location: { active: boolean; locating: boolean; hint: string; onLocate: () => void };
  fixed: {
    stop: FixedStop | null;
    inProgress: RadarContext['in_progress'];
    skipped: boolean;
    hint: string;
    onSkip: (value: boolean) => void;
    onRefresh: () => void;
  };
  shortWalk: boolean;
  onShortWalk: (value: boolean) => void;
  minutes: string;
  busy: boolean;
  canSubmit: boolean;
  onPlace: (kind: PlaceKind, place: PlaceOption | null) => void;
  onMinutes: (minutes: string) => void;
  onSubmit: () => void;
  onSessionExpired: (error: unknown) => boolean;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  const minutesInput = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState<PlaceKind | null>(null);
  const [custom, setCustom] = useState(!timePresets.includes(Number(minutes)));
  const activePreset = custom ? null : Number(minutes);

  function openPicker(kind: PlaceKind) {
    setPicking(kind);
  }

  useEffect(() => {
    const dialog = sheet.current;
    if (!picking || !dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('input')?.focus();
  }, [picking]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <>
      <form onSubmit={submit}>
        <fieldset className="radar-fields" disabled={busy}>
          <div className="panel radar-form">
            <section aria-label="选点">
              <div className="between location-title">
                <h2>
                  <Icon>⌖</Icon> 当前位置
                </h2>
                <button
                  className="text-button"
                  type="button"
                  onClick={location.onLocate}
                  disabled={location.locating}
                >
                  {location.locating ? '正在定位…' : '使用当前位置'}
                </button>
              </div>
              <div className="between place-row">
                <strong>
                  {location.active ? '我的当前位置' : (places.origin?.name ?? '尚未选择出发地')}
                </strong>
                <button
                  className="text-button"
                  type="button"
                  aria-label="手动选择出发地"
                  onClick={() => openPicker('origin')}
                >
                  手动选择 ›
                </button>
              </div>
              {location.hint && (
                <p className="radar-hint" role="status">
                  {location.hint}
                </p>
              )}
              <div className="between place-row destination-row">
                <strong>{places.destination?.name ?? '从收藏和附近找地点'}</strong>
                {places.destination && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onPlace('destination', null)}
                  >
                    联合搜索
                  </button>
                )}
                <button
                  className="text-button"
                  type="button"
                  aria-label="手动选择目的地"
                  onClick={() => openPicker('destination')}
                >
                  手动选择 ›
                </button>
              </div>
            </section>
            <section aria-labelledby="time-heading">
              <h2 id="time-heading">
                <Icon>◷</Icon> 我还有多少时间？
              </h2>
              <div className="chips" role="group" aria-label="常用时长">
                {timePresets.map((preset) => (
                  <button
                    className="chip"
                    type="button"
                    key={preset}
                    aria-pressed={activePreset === preset}
                    onClick={() => {
                      setCustom(false);
                      onMinutes(String(preset));
                    }}
                  >
                    {preset} 分钟
                  </button>
                ))}
                <button
                  className="chip"
                  type="button"
                  aria-pressed={custom}
                  aria-controls="custom-time"
                  onClick={() => {
                    setCustom(true);
                    requestAnimationFrame(() => minutesInput.current?.focus());
                  }}
                >
                  自定义
                </button>
              </div>
              <div id="custom-time" className="custom-time" hidden={!custom}>
                <label className="sr-only" htmlFor="radar-minutes">
                  可用时间（分钟）
                </label>
                <input
                  ref={minutesInput}
                  id="radar-minutes"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={720}
                  step={1}
                  required={custom}
                  value={minutes}
                  placeholder="输入分钟数"
                  onChange={(event) => onMinutes(event.target.value)}
                />
              </div>
            </section>
            {fixed.inProgress && (
              <section aria-labelledby="running-lock-heading">
                <h2 id="running-lock-heading">
                  <Icon>▦</Icon> 当前固定安排
                </h2>
                <p className="locked" role="status">
                  {fixed.inProgress.name}进行中 ·{' '}
                  {zonedClock(fixed.inProgress.ends_at, fixed.inProgress.time_zone)} 结束
                </p>
                <p className="radar-hint">安排结束后，检查时段再计算。</p>
                <button className="text-button" type="button" onClick={fixed.onRefresh}>
                  检查时段
                </button>
              </section>
            )}
            <section>
              <h2>
                <Icon>▦</Icon> 下一项固定安排 <small>（可选）</small>
              </h2>
              {fixed.hint && (
                <p role="status" className="radar-hint">
                  {fixed.hint}
                </p>
              )}
              {fixed.stop ? (
                <>
                  <a className="locked between" href="#trip">
                    {fixedClock(fixed.stop)} · {fixed.stop.name} <span aria-hidden="true">›</span>
                  </a>
                  {fixed.stop.address ? (
                    <p className="radar-hint">取距固定安排开始的时间和手选上限中较短的一项。</p>
                  ) : (
                    <>
                      <p className="radar-hint">缺少地点。可前往行程补全后再计算。</p>
                      <label className="radar-hint">
                        <input
                          type="checkbox"
                          checked={fixed.skipped}
                          onChange={(event) => fixed.onSkip(event.target.checked)}
                        />
                        本次不使用这个固定安排
                      </label>
                    </>
                  )}
                </>
              ) : (
                !fixed.hint && <p className="locked">今天暂无待开始的固定安排</p>
              )}
            </section>
            <section className="radar-preference-row">
              <h2>
                <Icon>☷</Icon> 本次偏好 <small>（可选）</small>
              </h2>
              <div className="chips">
                <span className="chip">步行模式</span>
                <button
                  className="chip"
                  type="button"
                  aria-pressed={shortWalk}
                  onClick={() => onShortWalk(!shortWalk)}
                >
                  轻松步行
                </button>
              </div>
            </section>
          </div>
          <div className="home-action">
            <button className="primary full cta" type="submit" disabled={!canSubmit}>
              <Icon>✧</Icon>
              {busy ? '正在计算…' : '现在去哪'}
            </button>
          </div>
        </fieldset>
        <p className="note quiet">♧ 先校验时间与路线，再推荐可行的地点</p>
      </form>
      <dialog
        ref={sheet}
        className="place-sheet"
        aria-labelledby="place-sheet-title"
        onClose={() => setPicking(null)}
      >
        {picking && (
          <>
            <h2 id="place-sheet-title">手动选择{placeLabels[picking]}</h2>
            <PlaceField
              key={picking}
              id={`radar-${picking}`}
              label={placeLabels[picking]}
              placeholder="输入地点名称"
              value={places[picking]}
              onSessionExpired={onSessionExpired}
              onSelect={(place) => {
                onPlace(picking, place);
                if (place) sheet.current?.close();
              }}
            />
            <button className="secondary full" type="button" onClick={() => sheet.current?.close()}>
              关闭
            </button>
          </>
        )}
      </dialog>
    </>
  );
}

export function fixedClock({ starts_at, time_zone }: FixedStop) {
  return zonedClock(starts_at, time_zone);
}

function zonedClock(at: string, timeZone: string) {
  return new Date(at).toLocaleTimeString('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function clock(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

type Pick = Extract<RadarOutcome, { kind: 'recommendations' }>['best'];

export function PickCard({
  pick,
  view,
  accepting,
  writable,
  historical,
  candidate,
  primary,
  expired,
  onConfirm,
  onEdit,
  onRecalculate,
  changeAction,
}: {
  pick: Pick;
  view: RadarView;
  candidate: RadarCandidate | undefined;
  primary: boolean;
  expired: boolean;
  accepting: boolean;
  writable: boolean;
  historical: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  onRecalculate: () => void;
  changeAction: ReactNode;
}) {
  const place = candidate?.place ?? view.destination;
  const remaining = candidate?.remaining_min ?? view.window?.remaining_min;
  const expiry = candidate?.valid_until ?? view.valid_until;
  const facts = candidate?.facts ?? view.facts;
  const total =
    pick.travel_to_min + (pick.travel_to_next_min ?? 0) + pick.stay_min_estimate + pick.buffer_min;
  return (
    <article className="panel pick">
      <div className="pick-top">
        <span className="place-mark" aria-hidden="true">
          <span className="nav-icon nav-radar" />
        </span>
        <div>
          <span className={`badge${primary ? ' lime' : ''}`}>{primary ? '优先推荐' : '备选'}</span>
          <h3>{place.name}</h3>
          {place.address && <small>{place.address}</small>}
          {candidate && (
            <p className="muted">
              {candidate.sources
                .map((source) => (source === 'wishlist' ? '灵感库收藏' : '高德附近'))
                .join(' · ')}
            </p>
          )}
        </div>
      </div>
      <p className="reason">
        <strong>✧ 推荐理由</strong>　{pick.choice.reason_text}
      </p>
      <div className="times">
        <div>
          <small>步行前往</small>
          <strong>约 {pick.travel_to_min} 分钟</strong>
        </div>
        <div>
          <small>建议停留</small>
          <strong>约 {pick.stay_min_estimate} 分钟</strong>
        </div>
        {pick.travel_to_next_min !== null && (
          <div>
            <small>下一站</small>
            <strong>{pick.travel_to_next_min} 分钟</strong>
          </div>
        )}
        {pick.buffer_min > 0 && (
          <div>
            <small>缓冲</small>
            <strong>{pick.buffer_min} 分钟</strong>
          </div>
        )}
      </div>
      <div className="pick-bottom">
        <p className="muted">
          共约 {total} 分钟
          {remaining != null && ` · 计算时剩余 ${remaining} 分钟`}
        </p>
        <p className="muted">
          高德步行估算 · {clock(pick.evidence.fetched_at)} 获取
          {!expired && !historical && ` · ${clock(expiry)} 前可加入`}
        </p>
        <p className="muted">
          营业 {facts?.opening ? `高德今日 ${facts.opening.today}（已查询）` : '待核验'} · 预约{' '}
          {facts?.booking
            ? `${facts.booking.state === 'required' ? '需预约' : '无需预约'}（${facts.booking.source}，${facts.booking.status === 'stale' ? '已过期' : '已核验'}）`
            : '待核验'}{' '}
          · 价格 {facts?.price ? `高德参考 ${facts.price.text}（估计）` : '待核验'}
        </p>
        {expired && <p role="status">本项证据已过期，请重新计算。</p>}
        <div className="actions">
          {expired || !changeAction ? (
            <button
              className="secondary"
              type="button"
              disabled={accepting}
              onClick={expired ? onRecalculate : onEdit}
            >
              {expired ? '重新计算' : '返回修改'}
            </button>
          ) : (
            changeAction
          )}
          <button
            className="primary"
            type="button"
            disabled={accepting || !writable || expired}
            onClick={onConfirm}
          >
            {accepting ? '正在确认…' : '确认加入行程'}
          </button>
        </div>
      </div>
    </article>
  );
}
