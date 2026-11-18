import { useEffect, useRef, useState } from 'react';
import {
  browserPositionValidator,
  liveOriginId,
  type BrowserPosition,
  type Capabilities,
  type FixedStop,
  type PlaceOption,
  type RadarView,
} from '@nextstop/core';
import {
  ApiError,
  acceptRadar,
  createRadarSession,
  createSession,
  getRadarContext,
  getRadarHistory,
  getRadarSession,
  isCancellation,
} from './api.js';
import { fixedClock, Icon, RadarForm } from './RadarScreens.js';
import { RadarExclusions, RadarRecommendations } from './RadarRecommendations.js';
import { TripPanel } from './TripPanel.js';

type Session = { kind: 'loading' | 'ready' } | { kind: 'failed'; message: string };
type Result =
  | { kind: 'idle' | 'calculating' }
  | { kind: 'error'; message: string }
  | { kind: 'history'; view: RadarView; stale: boolean }
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
  const [position, setPosition] = useState<BrowserPosition | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationHint, setLocationHint] = useState('');
  const locationAttempt = useRef(0);
  const [fixed, setFixed] = useState<FixedStop | null>(null);
  const [contextHint, setContextHint] = useState('');
  const [skipFixed, setSkipFixed] = useState(false);
  const [shortWalk, setShortWalk] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyNote, setHistoryNote] = useState('');
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
            if (view.origin.id !== liveOriginId) setOrigin(view.origin);
            setDestination(view.candidates ? null : view.destination);
            setMinutes(String(view.window?.manual_min ?? view.available_min));
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

  useEffect(() => {
    if (page !== 'radar' || session.kind !== 'ready' || !capabilities.radar) return;
    const controller = new AbortController();
    void getRadarContext(controller.signal)
      .then(({ fixed }) => {
        if (controller.signal.aborted) return;
        setFixed(fixed);
        setContextHint('');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setContextHint(messageOf(error));
      });
    return () => controller.abort();
  }, [page, session.kind, capabilities.radar]);

  function clearProposal() {
    remember(null);
    setResult({ kind: 'idle' });
  }
  function locate() {
    if (locating) return;
    const signal = lifetime.current?.signal;
    const attemptId = ++locationAttempt.current;
    if (!navigator.geolocation) {
      setLocationHint('此浏览器无法定位，请手动选择出发地。');
      return;
    }
    setLocating(true);
    setLocationHint('');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (signal?.aborted || attemptId !== locationAttempt.current) return;
        setLocating(false);
        const point = {
          system: 'wgs84',
          longitude: coords.longitude,
          latitude: coords.latitude,
          accuracy_m: coords.accuracy,
        };
        if (!browserPositionValidator.check(point)) {
          setLocationHint('定位精度不足，请手动选择出发地。');
          return;
        }
        clearProposal();
        setPosition(point);
      },
      (error) => {
        if (signal?.aborted || attemptId !== locationAttempt.current) return;
        setLocating(false);
        setLocationHint(
          error.code === 1
            ? '定位权限未开启，请手动选择出发地。'
            : '暂时无法定位，请手动选择出发地。',
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 },
    );
  }
  async function openHistory() {
    const signal = lifetime.current?.signal;
    if (!signal || locked.current) return;
    locked.current = true;
    setHistoryLoading(true);
    try {
      const saved = await getRadarHistory(signal);
      if (signal.aborted) return;
      if (!saved) setResult({ kind: 'idle' });
      if (!saved) setHistoryNote('还没有保存的雷达结果。');
      else setResult({ kind: 'history', view: saved.view, stale: saved.status === 'stale' });
    } catch (error) {
      if (!signal.aborted && !sessionExpired(error))
        setResult({ kind: 'error', message: messageOf(error) });
    } finally {
      locked.current = false;
      setHistoryLoading(false);
    }
  }
  const available = Number(minutes);
  const busy = result.kind === 'calculating' || result.kind === 'accepting' || historyLoading;
  const missingFixed = fixed !== null && !fixed.address;
  const canSubmit = Boolean(
    (origin || position) &&
    Number.isInteger(available) &&
    available >= 1 &&
    available <= 720 &&
    (!missingFixed || skipFixed) &&
    !busy &&
    !locating,
  );
  async function calculate() {
    const signal = lifetime.current?.signal;
    if (!canSubmit || locked.current || !signal) return;
    const source = position ? { position } : origin ? { origin_id: origin.id } : null;
    if (!source) return;
    locked.current = true;
    remember(null);
    setResult({ kind: 'calculating' });
    try {
      const view = await createRadarSession(
        {
          ...source,
          ...(destination ? { poi_id: destination.id } : {}),
          available_min: available,
          fixed_mode: missingFixed && skipFixed ? 'without_fixed' : 'next_locked',
          ...(shortWalk ? { preference: 'short_walk' } : {}),
        },
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
  const shown = 'view' in result ? result.view : null;
  const showResults = shown !== null || result.kind === 'stale' || result.kind === 'done';

  function editResult() {
    if (result.kind === 'history') {
      ++locationAttempt.current;
      setLocating(false);
      setLocationHint('');
      setPosition(null);
      setOrigin(result.view.origin.id === liveOriginId ? null : result.view.origin);
      setDestination(result.view.candidates ? null : result.view.destination);
      setMinutes(String(result.view.window?.manual_min ?? result.view.available_min));
    }
    clearProposal();
  }

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
        {(sessionStatus || result.kind === 'accepting') && (
          <header className="bar">
            <h1>我的行程</h1>
          </header>
        )}
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
              location={{
                active: Boolean(position),
                locating,
                hint: locationHint,
                onLocate: locate,
              }}
              fixed={{ stop: fixed, skipped: skipFixed, hint: contextHint, onSkip: setSkipFixed }}
              shortWalk={shortWalk}
              onShortWalk={setShortWalk}
              minutes={minutes}
              busy={busy}
              canSubmit={canSubmit}
              onPlace={(kind, place) => {
                clearProposal();
                if (kind === 'origin') {
                  ++locationAttempt.current;
                  setLocating(false);
                  setLocationHint('');
                  setPosition(null);
                  setOrigin(place);
                } else setDestination(place);
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
        {session.kind === 'ready' && capabilities.radar && (
          <div className="radar-history-link">
            <button
              type="button"
              className="text-button"
              onClick={() => void openHistory()}
              disabled={busy}
            >
              {historyLoading ? '读取历史结果…' : '查看上次雷达结果 ›'}
            </button>
            {historyNote && <p role="status">{historyNote}</p>}
          </div>
        )}
        {result.kind === 'error' && (
          <div className="note" role="alert">
            <p>{result.message}</p>
            <button
              type="button"
              className="secondary"
              disabled={!canSubmit}
              onClick={() => void calculate()}
            >
              重试计算
            </button>
          </div>
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
          onClick={editResult}
          disabled={busy}
          aria-label="返回雷达"
        >
          ‹
        </button>
        <h1>{result.kind === 'history' ? '上次雷达结果' : '推荐结果'}</h1>
        <button type="button" className="secondary mini" disabled={busy} onClick={editResult}>
          {result.kind === 'history' ? '使用上次条件' : '修改条件'}
        </button>
      </header>
      <section className="result" aria-live="polite">
        {shown && (
          <p className="context">
            <Icon>⌖</Icon> {shown.origin.name} · <Icon>◷</Icon> {shown.available_min} 分钟 · 步行
          </p>
        )}
        {shown?.window && (
          <p className="radar-hint">
            手选上限 {shown.window.manual_min} 分钟
            {shown.window.fixed &&
              ` · ${fixedClock(shown.window.fixed)} ${shown.window.fixed.name}`}
            {' · '}
            {shown.window.limited_by === 'fixed'
              ? '按固定截止'
              : shown.window.limited_by === 'both'
                ? '两项上限相同'
                : '按手选上限'}
          </p>
        )}
        {result.kind === 'history' && (
          <p className="note" role="status">
            {result.stale ? '历史证据已过期或行程已更新。' : '这是上次保存的结果。'}{' '}
            重新核验后才能确认。
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
          <div className="note" role="status">
            <p>当前条件下没有可行方案，建议不绕路。</p>
            <p>
              {shown.window?.fixed
                ? `可以直接前往 ${shown.window.fixed.name}，或先休息。`
                : '可以就近休息，或调整时间后再试。'}
            </p>
            <RadarExclusions entries={shown.excluded} />
          </div>
        )}
        {shown?.outcome.kind === 'recommendations' && (
          <RadarRecommendations
            key={shown.outcome.binding.proposal_id}
            view={shown}
            outcome={shown.outcome}
            accepting={result.kind === 'accepting'}
            writable={capabilities.trip_writes && result.kind !== 'history'}
            historical={result.kind === 'history'}
            onConfirm={(poiId) => void confirm(shown, poiId)}
            onEdit={editResult}
            onRecalculate={canSubmit ? () => void calculate() : editResult}
          />
        )}
      </section>
    </>
  );
}
