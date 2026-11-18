import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Capabilities, PlaceOption, RadarView, TripView } from '@nextstop/core';
import {
  ApiError,
  acceptRadar,
  createRadarSession,
  createSession,
  getRadarSession,
  getTrip,
  isCancellation,
} from './api.js';
import { Icon, PickCard, RadarForm } from './RadarScreens.js';

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
function TripPanel({ onSessionExpired }: { onSessionExpired: (error: unknown) => boolean }) {
  const [trip, setTrip] = useState<Trip>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reportSession = useEffectEvent(onSessionExpired);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setTrip({ kind: 'loading' });
    void (async () => {
      try {
        const value = await getTrip(signal);
        if (!signal.aborted) setTrip({ kind: 'ready', value });
      } catch (error) {
        if (!signal.aborted && !reportSession(error)) {
          setTrip({ kind: 'failed', message: messageOf(error) });
        }
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  return (
    <section className="trip" aria-labelledby="stops-heading">
      {trip.kind === 'ready' && trip.value?.stops.length ? (
        <div className="panel list-row trip-card">
          <img src="/prototype/assets/hero.webp" alt="" />
          <span>
            <strong>苏州行程</strong>
            <small>已加入 {trip.value.stops.length} 个地点</small>
            <small>个人行程 · 步行</small>
          </span>
        </div>
      ) : null}
      <div className="segment trip-segment">
        <h2 id="stops-heading">行程安排</h2>
        <span className="muted">未安排地点 · 暂未开放</span>
      </div>
      {trip.kind === 'loading' && <p role="status">正在读取行程…</p>}
      {trip.kind === 'failed' && (
        <>
          <p role="alert">行程读取失败：{trip.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重试读取行程
          </button>
        </>
      )}
      {trip.kind === 'ready' &&
        (trip.value?.stops.length ? (
          <ol className="timeline" role="list">
            {trip.value.stops.map((stop, index) => (
              <li key={stop.stop_id}>
                <span className="stop-order">第 {index + 1} 站</span>
                <i aria-hidden="true" />
                <strong>{stop.name}</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">还没有已加入的地点。确认雷达推荐后，地点会出现在这里。</p>
        ))}
      <p className="note">目前可从机会雷达加入地点。旅行编辑和 AI 草案尚未开放。</p>
    </section>
  );
}

export function RadarPanel({
  capabilities,
  page,
}: {
  capabilities: Capabilities;
  page: 'radar' | 'trip' | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const [origin, setOrigin] = useState<PlaceOption | null>(null);
  const [destination, setDestination] = useState<PlaceOption | null>(null);
  const [minutes, setMinutes] = useState('75');
  const lifetime = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const canOpen = capabilities.radar || capabilities.trip_writes;

  function sessionExpired(error: unknown) {
    if (!(error instanceof ApiError) || error.code !== 'SESSION_REQUIRED') return false;
    remember(null);
    setResult({ kind: 'idle' });
    setSession({ kind: 'failed', message: '匿名会话已过期，请重新建立会话。' });
    return true;
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
    } catch (error) {
      if (signal.aborted || isCancellation(error) || sessionExpired(error)) return;
      if (error instanceof ApiError && error.code === 'PROPOSAL_STALE') {
        remember(null);
        setResult({ kind: 'stale', message: error.message });
      } else setResult({ kind: 'shown', view, failure: messageOf(error) });
    } finally {
      locked.current = false;
    }
  }
  const shown = result.kind === 'shown' || result.kind === 'accepting' ? result.view : null;
  const showResults = shown !== null || result.kind === 'stale' || result.kind === 'done';

  useEffect(() => {
    if (page === 'radar' && showResults) document.getElementById('screen')?.scrollTo(0, 0);
  }, [page, showResults]);

  if (!page) return null;
  const sessionStatus = !canOpen ? (
    <p role="status" className="note">
      {page === 'trip' ? '行程服务暂不可用。' : '雷达尚未配置，暂时无法搜索地点。'}
    </p>
  ) : session.kind === 'loading' ? (
    <p role="status" className="note">
      正在建立访客会话…
    </p>
  ) : session.kind === 'failed' ? (
    <div className="note">
      <p role="alert">{session.message}</p>
      <button className="secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>
        重新建立会话
      </button>
    </div>
  ) : null;

  if (page === 'trip') {
    return (
      <>
        <header className="bar">
          <h1>我的行程</h1>
          <button type="button" className="primary mini" disabled>
            ＋ 新建旅行
          </button>
        </header>
        {sessionStatus ??
          (result.kind === 'accepting' ? (
            <p role="status" className="note">
              正在确认地点，完成后将读取行程…
            </p>
          ) : (
            <TripPanel onSessionExpired={sessionExpired} />
          ))}
      </>
    );
  }

  if (!showResults) {
    return (
      <>
        <header className="bar">
          <a className="brand" href="#radar" aria-label="下一站首页">
            <img src="/prototype/assets/logo.webp" alt="" />
            <span>
              NEXTSTOP <small>/ 下一站</small>
            </span>
          </a>
          <a href="#settings" className="icon-button about" aria-label="服务连接与设置">
            ⓘ
          </a>
        </header>
        <section className="hero">
          <span className="eyebrow">SUZHOU · CITY EXPLORER</span>
          <h1>
            现在去哪<span>？</span>
          </h1>
          <p>
            把空闲时间变成一段刚刚好的旅行。
            <br />
            看看现在步行能去哪一站。
          </p>
        </section>
        {sessionStatus ??
          (capabilities.radar ? (
            <RadarForm
              places={{ origin, destination }}
              minutes={minutes}
              busy={busy}
              canSubmit={canSubmit}
              onPlace={(kind, place) => {
                clearProposal();
                if (kind === 'origin') setOrigin(place);
                else setDestination(place);
              }}
              onMinutes={(value) => {
                clearProposal();
                setMinutes(value);
              }}
              onSubmit={() => void calculate()}
              onSessionExpired={sessionExpired}
            />
          ) : (
            <p role="status" className="note">
              地图服务尚未配置，已有行程仍可查看。
            </p>
          ))}
        {result.kind === 'error' && (
          <p className="note" role="alert">
            {result.message}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <header className="bar">
        <button
          type="button"
          className="icon-button back"
          onClick={clearProposal}
          disabled={busy}
          aria-label="返回雷达"
        >
          ‹
        </button>
        <h1>推荐结果</h1>
        <button type="button" className="secondary mini" disabled={busy} onClick={clearProposal}>
          修改条件
        </button>
      </header>
      <section className="result" aria-live="polite">
        {shown && (
          <p className="context">
            <Icon>⌖</Icon> {shown.origin.name} · <Icon>◷</Icon> {shown.available_min} 分钟 · 步行
          </p>
        )}
        {result.kind === 'stale' && (
          <div role="alert" className="note">
            <p>提案已失效 · PROPOSAL_STALE</p>
            <p>{result.message}</p>
            <button className="primary" type="button" onClick={() => void calculate()}>
              重新计算
            </button>
          </div>
        )}
        {result.kind === 'done' && (
          <div className="panel padded-panel">
            <p role="status">已加入行程：{result.name}</p>
            <a href="#trip" className="primary">
              查看已加入的地点 →
            </a>
          </div>
        )}
        {result.kind === 'shown' && result.failure && (
          <p className="note" role="alert">
            确认失败：{result.failure}
          </p>
        )}
        {shown?.outcome.kind === 'empty' && (
          <p className="note" role="status">
            当前条件下没有可行方案。可以延长可用时间或换个地点。
          </p>
        )}
        {shown?.outcome.kind === 'recommendations' && (
          <PickCard
            pick={shown.outcome.best}
            view={shown}
            accepting={result.kind === 'accepting'}
            writable={capabilities.trip_writes}
            onConfirm={() => void confirm(shown, shown.destination.id)}
            onEdit={clearProposal}
          />
        )}
      </section>
    </>
  );
}
