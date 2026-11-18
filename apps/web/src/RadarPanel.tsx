import { useEffect, useRef, useState } from 'react';
import type { Capabilities, PlaceOption, RadarOutcome, RadarView, TripView } from '@nextstop/core';
import {
  ApiError,
  acceptRadar,
  createRadarSession,
  createSession,
  getRadarSession,
  getTrip,
  isCancellation,
} from './api.js';
import { PlaceField } from './PlaceField.js';

type Session = { kind: 'loading' | 'ready' } | { kind: 'failed'; message: string };
type Trip =
  | { kind: 'loading' }
  | { kind: 'ready'; value: TripView | null }
  | { kind: 'failed'; message: string };
type Result =
  | { kind: 'idle' | 'calculating' }
  | { kind: 'error'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'shown'; view: RadarView; failure?: string }
  | { kind: 'accepting'; view: RadarView }
  | { kind: 'done'; name: string };
const draftKey = 'nextstop.radar-session';
function draftId() {
  try {
    return sessionStorage.getItem(draftKey);
  } catch {
    return null;
  }
}
function remember(id: string | null) {
  try {
    if (id) sessionStorage.setItem(draftKey, id);
    else sessionStorage.removeItem(draftKey);
  } catch {
    /* Restoring a form is optional. Confirmation does not depend on browser storage. */
  }
}
function messageOf(error: unknown) {
  return error instanceof ApiError ? error.message : '无法读取服务响应，请重试。';
}
function clock(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

type Pick = Extract<RadarOutcome, { kind: 'recommendations' }>['best'];
function PickCard({
  pick,
  view,
  disabled,
  onConfirm,
}: {
  pick: Pick;
  view: RadarView;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const total =
    pick.travel_to_min + (pick.travel_to_next_min ?? 0) + pick.stay_min_estimate + pick.buffer_min;
  return (
    <article className="pick">
      <strong>{view.destination.name}</strong>
      <p>{pick.choice.reason_text}</p>
      <dl className="estimates">
        <div>
          <dt>步行前往</dt>
          <dd>约 {pick.travel_to_min} 分钟</dd>
        </div>
        <div>
          <dt>建议停留</dt>
          <dd>约 {pick.stay_min_estimate} 分钟</dd>
        </div>
        <div>
          <dt>缓冲</dt>
          <dd>{pick.buffer_min} 分钟</dd>
        </div>
        <div>
          <dt>营业、预约和价格</dt>
          <dd>待自行确认</dd>
        </div>
      </dl>
      <p className="evidence">
        高德步行估算 · {clock(pick.evidence.fetched_at)} 获取。预计共 {total} 分钟，可用{' '}
        {view.available_min} 分钟。
      </p>
      <p className="hint">本次追加到行程末尾。请在 {clock(view.valid_until)} 前确认。</p>
      <button type="button" disabled={disabled} onClick={onConfirm}>
        {disabled ? '正在确认…' : '确认加入行程'}
      </button>
    </article>
  );
}

export function RadarPanel({ capabilities }: { capabilities: Capabilities }) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [trip, setTrip] = useState<Trip>({ kind: 'loading' });
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const [origin, setOrigin] = useState<PlaceOption | null>(null);
  const [destination, setDestination] = useState<PlaceOption | null>(null);
  const [minutes, setMinutes] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const tripRead = useRef(0);
  const canOpen = capabilities.radar || capabilities.trip_writes;

  function sessionExpired(error: unknown) {
    if (!(error instanceof ApiError) || error.code !== 'SESSION_REQUIRED') return false;
    remember(null);
    setResult({ kind: 'idle' });
    setSession({ kind: 'failed', message: '匿名会话已过期，请重新建立会话。' });
    return true;
  }
  async function loadTrip(signal: AbortSignal) {
    const read = ++tripRead.current;
    setTrip({ kind: 'loading' });
    try {
      const value = await getTrip(signal);
      if (!signal.aborted && read === tripRead.current) setTrip({ kind: 'ready', value });
    } catch (error) {
      if (!signal.aborted && read === tripRead.current && !sessionExpired(error))
        setTrip({ kind: 'failed', message: messageOf(error) });
    }
  }
  useEffect(() => {
    if (!canOpen) return;
    const controller = new AbortController();
    lifetime.current = controller;
    const { signal } = controller;
    setSession({ kind: 'loading' });
    setResult({ kind: 'idle' });
    void (async () => {
      try {
        await createSession(signal);
        if (signal.aborted) return;
        // Keep the form closed until restoration finishes so an old selection never replaces new input.
        const id = draftId();
        if (id && capabilities.radar) {
          try {
            const view = await getRadarSession(id, signal);
            if (signal.aborted) return;
            setOrigin(view.origin);
            setDestination(view.destination);
            setMinutes(String(view.available_min));
            setResult({ kind: 'shown', view });
          } catch (error) {
            if (signal.aborted || sessionExpired(error)) return;
            if (error instanceof ApiError && (error.status === 404 || error.status === 409))
              remember(null);
            setResult({ kind: 'error', message: messageOf(error) });
          }
        }
        setSession({ kind: 'ready' });
        await loadTrip(signal);
      } catch (error) {
        if (!signal.aborted) setSession({ kind: 'failed', message: messageOf(error) });
      }
    })();
    return () => {
      controller.abort();
      lifetime.current = null;
    };
  }, [attempt, canOpen, capabilities.radar]);

  function clearProposal() {
    remember(null);
    setResult({ kind: 'idle' });
  }
  const available = Number(minutes);
  const busy = result.kind === 'calculating' || result.kind === 'accepting';
  const canSubmit = Boolean(
    origin &&
    destination &&
    Number.isInteger(available) &&
    available >= 1 &&
    available <= 720 &&
    !busy,
  );
  async function calculate() {
    const signal = lifetime.current?.signal;
    if (!origin || !destination || !canSubmit || locked.current || !signal) return;
    locked.current = true;
    remember(null);
    setResult({ kind: 'calculating' });
    try {
      const view = await createRadarSession(
        { origin_id: origin.id, poi_id: destination.id, available_min: available },
        signal,
      );
      if (signal.aborted) return;
      remember(view.outcome.binding.session_id);
      setResult({ kind: 'shown', view });
    } catch (error) {
      if (!signal.aborted && !sessionExpired(error))
        setResult({ kind: 'error', message: messageOf(error) });
    } finally {
      locked.current = false;
    }
  }
  async function confirm(view: RadarView, poiId: string) {
    const signal = lifetime.current?.signal;
    if (locked.current || !signal || !capabilities.trip_writes) return;
    locked.current = true;
    setResult({ kind: 'accepting', view });
    const binding = view.outcome.binding;
    try {
      // One choice per proposal. Every tab and retry can reconstruct the same confirmation key.
      const receipt = await acceptRadar(
        binding.session_id,
        { binding, poi_id: poiId },
        binding.proposal_id,
        signal,
      );
      if (signal.aborted) return;
      remember(null);
      setResult({ kind: 'done', name: receipt.stop.name });
      void loadTrip(signal);
    } catch (error) {
      if (signal.aborted || isCancellation(error) || sessionExpired(error)) return;
      if (error instanceof ApiError && error.code === 'PROPOSAL_STALE') {
        remember(null);
        setResult({ kind: 'stale', message: error.message });
        void loadTrip(signal);
      } else setResult({ kind: 'shown', view, failure: messageOf(error) });
    } finally {
      locked.current = false;
    }
  }
  const shown = result.kind === 'shown' || result.kind === 'accepting' ? result.view : null;
  return (
    <section className="panel radar" aria-labelledby="radar-heading">
      <h2 id="radar-heading">机会雷达</h2>
      {!canOpen ? (
        <p role="status">雷达尚未配置，暂时无法搜索地点。</p>
      ) : session.kind === 'loading' ? (
        <p role="status">正在读取你的行程…</p>
      ) : session.kind === 'failed' ? (
        <>
          <p role="alert">{session.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重新建立会话
          </button>
        </>
      ) : (
        <>
          {capabilities.radar ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void calculate();
              }}
            >
              <fieldset disabled={busy}>
                <PlaceField
                  id="radar-origin"
                  label="出发地"
                  placeholder="搜索当前位置"
                  value={origin}
                  onSessionExpired={sessionExpired}
                  onSelect={(value) => {
                    clearProposal();
                    setOrigin(value);
                  }}
                />
                <PlaceField
                  id="radar-destination"
                  label="候选目的地"
                  placeholder="搜索想去的地点"
                  value={destination}
                  onSessionExpired={sessionExpired}
                  onSelect={(value) => {
                    clearProposal();
                    setDestination(value);
                  }}
                />
                <div className="field">
                  <label htmlFor="radar-minutes">可用时间（分钟）</label>
                  <input
                    id="radar-minutes"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={720}
                    step={1}
                    required
                    value={minutes}
                    placeholder="例如 90"
                    onChange={(event) => {
                      clearProposal();
                      setMinutes(event.target.value);
                    }}
                  />
                </div>
                <button type="submit" disabled={!canSubmit}>
                  {result.kind === 'calculating' ? '正在计算…' : '查找下一站'}
                </button>
              </fieldset>
            </form>
          ) : (
            <p role="status">地图服务尚未配置，已有行程仍可查看。</p>
          )}
          <div className="result" aria-live="polite">
            {result.kind === 'error' && <p role="alert">{result.message}</p>}
            {result.kind === 'stale' && (
              <div role="alert">
                <p>提案已失效 · PROPOSAL_STALE</p>
                <p>{result.message}</p>
                <button type="button" onClick={() => void calculate()}>
                  重新计算
                </button>
              </div>
            )}
            {result.kind === 'done' && (
              <p role="status" className="done">
                已加入行程：{result.name}
              </p>
            )}
            {result.kind === 'shown' && result.failure && (
              <p role="alert">确认失败：{result.failure}</p>
            )}
            {shown?.outcome.kind === 'empty' && (
              <p role="status">当前条件下没有可行方案。可以延长可用时间或换个地点。</p>
            )}
            {shown?.outcome.kind === 'recommendations' && (
              <PickCard
                pick={shown.outcome.best}
                view={shown}
                disabled={result.kind === 'accepting' || !capabilities.trip_writes}
                onConfirm={() => void confirm(shown, shown.destination.id)}
              />
            )}
          </div>
          <section className="trip" aria-labelledby="trip-heading">
            <h3 id="trip-heading">我的行程</h3>
            {trip.kind === 'loading' && <p role="status">正在读取行程…</p>}
            {trip.kind === 'failed' && (
              <>
                <p role="alert">行程读取失败：{trip.message}</p>
                <button
                  type="button"
                  onClick={() => {
                    if (lifetime.current) void loadTrip(lifetime.current.signal);
                  }}
                >
                  重试读取行程
                </button>
              </>
            )}
            {trip.kind === 'ready' &&
              (trip.value ? (
                <ol>
                  {trip.value.stops.map((stop) => (
                    <li key={stop.stop_id}>{stop.name}</li>
                  ))}
                </ol>
              ) : (
                <p>还没有行程。确认地点后，它会出现在这里。</p>
              ))}
          </section>
        </>
      )}
    </section>
  );
}
