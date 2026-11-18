import type { PlaceOption, RadarOutcome, RadarView } from '@nextstop/core';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
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
  minutes,
  busy,
  canSubmit,
  onPlace,
  onMinutes,
  onSubmit,
  onSessionExpired,
}: {
  places: Record<PlaceKind, PlaceOption | null>;
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
              <h2>
                <Icon>⌖</Icon> 当前位置
              </h2>
              <div className="between place-row">
                <strong>{places.origin?.name ?? '尚未选择出发地'}</strong>
                <button
                  className="text-button"
                  type="button"
                  aria-label="手动选择出发地"
                  onClick={() => openPicker('origin')}
                >
                  手动选择 ›
                </button>
              </div>
              <div className="between place-row destination-row">
                <strong>{places.destination?.name ?? '尚未选择目的地'}</strong>
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
            <section>
              <h2>
                <Icon>▦</Icon> 下一项固定安排 <small>（可选）</small>
              </h2>
              <p className="locked between">
                固定安排尚未开放 <span aria-hidden="true">›</span>
              </p>
            </section>
            <section>
              <h2>
                <Icon>☷</Icon> 本次偏好 <small>（可选）</small>
              </h2>
              <div className="chips">
                <span className="chip selected-chip">步行</span>
                <span className="chip muted">历史人文</span>
                <span className="chip muted">小众安静</span>
                <span className="chip muted">室内</span>
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
  onConfirm,
  onEdit,
}: {
  pick: Pick;
  view: RadarView;
  accepting: boolean;
  writable: boolean;
  onConfirm: () => void;
  onEdit: () => void;
}) {
  const total =
    pick.travel_to_min + (pick.travel_to_next_min ?? 0) + pick.stay_min_estimate + pick.buffer_min;
  return (
    <>
      <div
        className="map alt route-preview"
        aria-label={`路线示意：${view.origin.name}到${view.destination.name}`}
      >
        <span className="map-river" aria-hidden="true" />
        <span className="route-line" aria-hidden="true" />
        <span className="map-start">● 起点</span>
        <span className="map-pin">◉ {view.destination.name}</span>
        <span className="map-caption">示意路线 · 无地图坐标</span>
      </div>
      <div className="between title-row">
        <h2>为你找到的选择</h2>
        <small>高德步行估算</small>
      </div>
      <article className="panel pick">
        <div className="pick-top">
          <span className="place-mark" aria-hidden="true">
            ⌖
          </span>
          <div>
            <span className="badge lime">优先推荐</span>
            <h3>{view.destination.name}</h3>
            {view.destination.address && <small>{view.destination.address}</small>}
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
          <div>
            <small>缓冲</small>
            <strong>{pick.buffer_min} 分钟</strong>
          </div>
        </div>
        <div className="pick-bottom">
          <p className="muted">
            共约 {total} 分钟 · {clock(pick.evidence.fetched_at)} 获取
          </p>
          <p className="muted">营业、预约和价格待确认 · {clock(view.valid_until)} 前可加入</p>
          <div className="actions">
            <button className="secondary" type="button" disabled={accepting} onClick={onEdit}>
              返回修改
            </button>
            <button
              className="primary"
              type="button"
              disabled={accepting || !writable}
              onClick={onConfirm}
            >
              {accepting ? '正在确认…' : '确认加入行程'}
            </button>
          </div>
        </div>
      </article>
    </>
  );
}
