import type { Arrangement, TripDetail, TripList } from '@nextstop/core';
import { useEffect, useEffectEvent, useState } from 'react';
import {
  ApiError,
  createTrip,
  editTrip,
  getTripDetail,
  listTrips,
  saveArrangement,
} from './api.js';
import { ArrangementForm, TripDayForm } from './TripForms.js';
import './trip.css';

type Editor = { kind: 'create' | 'edit' } | { kind: 'arrangement'; item?: Arrangement };
type TripState = { list: TripList; selected: TripDetail | null };
const messageOf = (error: unknown) =>
  error instanceof ApiError ? error.message : '无法读取行程，请重试。';

function Timeline({
  trip,
  busy,
  edit,
}: {
  trip: TripDetail;
  busy: boolean;
  edit: (item: Arrangement) => void;
}) {
  const names = new Map(trip.arrangements.map((item) => [item.arrangement_id, item.name]));
  return (
    <>
      <h3>{trip.day?.date ?? '雷达已加入'}</h3>
      {trip.day && (
        <p className="note">
          {trip.day.start}–{trip.day.end} · {trip.day.time_zone}
        </p>
      )}
      {trip.arrangements.length > 0 && (
        <ol className="timeline" role="list">
          {[...trip.arrangements]
            .sort((a, b) => a.start.localeCompare(b.start))
            .map((item) => (
              <li key={item.arrangement_id} className={item.locked ? 'fixed' : undefined}>
                <time>{item.start}</time>
                <i aria-hidden="true" />
                <div className="trip-entry">
                  <strong>{item.name}</strong>
                  <small>
                    {item.start}–{item.end} · {item.locked ? '已锁定' : '未锁定'}
                  </small>
                  <small>{item.address || '缺少地点，请补全地址。'}</small>
                  {trip.warnings
                    .filter((warning) => warning.arrangement_id === item.arrangement_id)
                    .map((warning) => {
                      if (warning.kind === 'missing_location') return null;
                      if (warning.kind === 'outside_trip_hours')
                        return (
                          <small key={warning.kind} className="trip-warning">
                            超出游玩时段，需人工决定。
                          </small>
                        );
                      return (
                        <small key={warning.other_id} className="trip-warning">
                          与「{names.get(warning.other_id)}」时间冲突，需人工决定。
                        </small>
                      );
                    })}
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    onClick={() => edit(item)}
                  >
                    编辑安排
                  </button>
                </div>
              </li>
            ))}
        </ol>
      )}
      {trip.stops.length > 0 && (
        <ol className="timeline" role="list">
          {trip.stops.map((stop, index) => (
            <li key={stop.stop_id}>
              <span className="stop-order">第 {index + 1} 站</span>
              <i aria-hidden="true" />
              <div className="trip-entry">
                <strong>{stop.name}</strong>
                {trip.day && <small>雷达已加入 · 时间未安排</small>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function TripPanel({ onSessionExpired }: { onSessionExpired: (error: unknown) => boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TripState | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reportSession = useEffectEvent(onSessionExpired);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const list = await listTrips(signal);
        const selected = list.current_trip_id
          ? await getTripDetail(list.current_trip_id, signal)
          : null;
        if (!signal.aborted) setState({ list, selected });
      } catch (failure) {
        if (!signal.aborted && !reportSession(failure)) setError(messageOf(failure));
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  const selected = state?.selected;
  const cancel = () => {
    setEditor(null);
    setError('');
  };
  const open = (next: Editor) => {
    setError('');
    setEditor(next);
  };
  const reload = () => {
    cancel();
    setState(null);
    setAttempt((value) => value + 1);
  };
  async function update(run: () => Promise<TripDetail>, creating = false) {
    if (busy || !state) return;
    setBusy(true);
    setError('');
    try {
      const trip = await run();
      const summary = { trip_id: trip.trip_id, revision: trip.revision, day: trip.day };
      const { list } = state;
      const trips = creating
        ? [summary, ...list.trips]
        : list.trips.map((row) => (row.trip_id === trip.trip_id ? summary : row));
      setState({
        selected: trip,
        list: { trips, current_trip_id: creating ? trip.trip_id : list.current_trip_id },
      });
      setEditor(null);
    } catch (failure) {
      if (!onSessionExpired(failure)) setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="bar">
        <h1>我的行程</h1>
        <button
          type="button"
          className="primary mini"
          disabled={!state || busy}
          onClick={() => open({ kind: 'create' })}
        >
          ＋ 新建旅行
        </button>
      </header>
      <section className="trip" aria-labelledby="stops-heading">
        {state?.list.trips.map(({ trip_id, day }) => (
          <button
            key={trip_id}
            type="button"
            className="panel list-row trip-card"
            aria-pressed={selected?.trip_id === trip_id}
            disabled={busy}
            onClick={() => void update(() => getTripDetail(trip_id))}
          >
            <img src="/prototype/assets/hero.webp" alt="" />
            <span>
              <strong>{day ? `${day.destination} 1 日游` : '雷达行程'}</strong>
              {day && (
                <small>
                  {day.date} · {day.start}–{day.end}
                </small>
              )}
              {state.list.current_trip_id === trip_id && <small>当前旅行 · 雷达加入到此行程</small>}
            </span>
          </button>
        ))}
        {editor?.kind === 'create' && (
          <TripDayForm
            key="create"
            busy={busy}
            cancel={cancel}
            save={(day) => void update(() => createTrip(day), true)}
          />
        )}
        {editor?.kind === 'edit' && selected && (
          <TripDayForm
            key="edit"
            day={selected.day}
            busy={busy}
            cancel={cancel}
            save={(day) => void update(() => editTrip(selected.trip_id, selected.revision, day))}
          />
        )}
        {editor?.kind === 'arrangement' && selected && (
          <ArrangementForm
            key={editor.item?.arrangement_id ?? 'new'}
            item={editor.item}
            busy={busy}
            cancel={cancel}
            save={(item) =>
              void update(() =>
                saveArrangement(
                  selected.trip_id,
                  selected.revision,
                  item,
                  editor.item?.arrangement_id,
                ),
              )
            }
          />
        )}
        {error && (
          <div className="note" role="alert">
            {error}{' '}
            <button className="text-button" type="button" onClick={reload}>
              重新读取行程
            </button>
          </div>
        )}
        <div className="segment trip-segment">
          <h2 id="stops-heading">行程安排</h2>
          {selected && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => open({ kind: 'edit' })}
            >
              {selected.day ? '编辑旅行' : '补全旅行资料'}
            </button>
          )}
        </div>
        {!state && !error && <p role="status">正在读取行程…</p>}
        {state && !selected && (
          <p className="note">还没有已加入的地点。新建旅行，或从机会雷达加入地点。</p>
        )}
        {selected && (
          <Timeline
            trip={selected}
            busy={busy}
            edit={(item) => open({ kind: 'arrangement', item })}
          />
        )}
        {selected?.day && (
          <button
            type="button"
            className="primary mini"
            disabled={busy}
            onClick={() => open({ kind: 'arrangement' })}
          >
            ＋ 添加固定安排
          </button>
        )}
      </section>
    </>
  );
}
