import {
  canAdjustDraftEntry,
  draftMoveTarget,
  type DraftEdit,
  type DraftEntry,
  type TripDetail,
  type TripDraft,
} from '@nextstop/core';
import { useEffect, useEffectEvent, useState } from 'react';
import { ApiError, getTripDetail } from './api.js';
import { applyDraft, editDraft, generateDraft, readDraft } from './draft-client.js';
import './trip-draft.css';

const reasons: Record<Extract<DraftEntry, { kind: 'unscheduled' }>['reason'], string> = {
  time_conflict: '游玩时段或固定安排之间没有足够时间。',
  walking_unknown: '步行时间待核验，暂不安排。请核对固定安排的地址。',
  capacity: '超出本次草案可排程的地点数量。',
  other_city: '地点不在本次旅行的目的地。',
};

function DraftRows({
  draft,
  disabled,
  adjust,
}: {
  draft: TripDraft;
  disabled: boolean;
  adjust: (edit: DraftEdit) => void;
}) {
  return (
    <ol className="draft-rows" aria-label="草案地点">
      {draft.entries.map((entry, index) => {
        const { poi_id, name, address } = entry;
        return (
          <li key={poi_id} className="draft-row" data-kind={entry.kind}>
            {entry.kind === 'scheduled' && (
              <time>
                {entry.start}–{entry.end}
              </time>
            )}
            <strong>{name}</strong>
            <small>{address || '地图未提供地址'}</small>
            {entry.kind === 'scheduled' && (
              <small>
                预计停留 {entry.stay_min} 分钟{entry.locked ? ' · 已锁定' : ''}
              </small>
            )}
            {entry.kind === 'unscheduled' && (
              <small className="draft-conflict">未安排 · {reasons[entry.reason]}</small>
            )}
            {entry.kind === 'skipped' && <small>已跳过</small>}
            <div className="draft-controls">
              {canAdjustDraftEntry(entry) && (
                <>
                  {(['up', 'down'] satisfies ('up' | 'down')[]).map((direction) => {
                    const label = direction === 'up' ? '上移' : '下移';
                    return (
                      <button
                        type="button"
                        className="text-button"
                        key={direction}
                        aria-label={`${label} ${name}`}
                        disabled={
                          disabled || draftMoveTarget(draft.entries, index, direction) === null
                        }
                        onClick={() => adjust({ kind: 'move', poi_id, direction })}
                      >
                        {label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`跳过 ${name}`}
                    disabled={disabled}
                    onClick={() => adjust({ kind: 'skip', poi_id })}
                  >
                    跳过
                  </button>
                </>
              )}
              {entry.kind === 'scheduled' && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`${entry.locked ? '解锁' : '锁定'} ${name}`}
                  disabled={disabled}
                  onClick={() => adjust({ kind: 'lock', poi_id, locked: !entry.locked })}
                >
                  {entry.locked ? '解锁' : '锁定'}
                </button>
              )}
              {entry.kind === 'skipped' && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`重新安排 ${name}`}
                  disabled={disabled}
                  onClick={() => adjust({ kind: 'restore', poi_id })}
                >
                  重新安排
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

type Preview = Awaited<ReturnType<typeof readDraft>>;
export function TripDraftPanel({
  trip,
  disabled,
  onTripChange,
  onSessionExpired,
}: {
  trip: TripDetail;
  disabled: boolean;
  onTripChange: (trip: TripDetail) => void;
  onSessionExpired: (error: unknown) => boolean;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState('');
  const [retry, setRetry] = useState(0);
  const [review, setReview] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reportSession = useEffectEvent(onSessionExpired);
  const { trip_id, revision } = trip;
  useEffect(() => {
    const controller = new AbortController();
    void readDraft(trip_id, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setPreview(result);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted && !reportSession(failure))
          setError('无法读取草案，请重试。');
      },
    );
    return () => controller.abort();
  }, [trip_id, revision, retry]);

  const draft = preview?.draft;
  const needsReview =
    review || preview?.needs_review || (draft && draft.trip_revision !== revision);
  const busy = disabled || Boolean(pending);
  const canApply = draft?.entries.some(({ kind }) => kind === 'scheduled');
  function show(next: TripDraft) {
    setPreview({ draft: next, needs_review: false });
    setReview(false);
  }
  async function perform(message: string, action: () => Promise<void>) {
    if (busy) return;
    setPending(message);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      if (onSessionExpired(failure)) return;
      if (failure instanceof ApiError && failure.code === 'DRAFT_STALE') setReview(true);
      else setError(failure instanceof ApiError ? failure.message : '无法更新草案，请重试。');
    } finally {
      setPending('');
    }
  }

  return (
    <section className="trip-draft" aria-label="一日行程草案">
      {draft ? (
        <div className="panel padded-panel draft-preview">
          <h2>行程草案预览</h2>
          <p>
            {draft.day.date} · {draft.day.start}–{draft.day.end}
          </p>
          <p className="note">营业时间和预约状态待核验。应用后保留现有活动与固定安排。</p>
          {draft.entries.length ? (
            <DraftRows
              draft={draft}
              disabled={busy || Boolean(needsReview)}
              adjust={(edit) =>
                void perform('正在更新草案…', async () =>
                  show(
                    await editDraft(
                      trip_id,
                      { draft_id: draft.draft_id, revision: draft.revision },
                      edit,
                    ),
                  ),
                )
              }
            />
          ) : (
            <p>
              本次旅行没有可安排的新收藏。<a href="#library">前往灵感库</a>
            </p>
          )}
        </div>
      ) : (
        <p className="note">从已确认收藏生成一日草案。你可以调整顺序、跳过或锁定活动。</p>
      )}
      <div role="status">{(pending || notice) && <p className="note">{pending || notice}</p>}</div>
      {error && <p role="alert">{error}</p>}
      {needsReview ? (
        <>
          <p className="note" role="alert">
            行程或草案已更新，请重新核对后再确认应用。
          </p>
          <button
            type="button"
            className="primary full"
            disabled={busy}
            onClick={() =>
              void perform('正在重新核对草案…', async () => {
                const latest = await getTripDetail(trip_id);
                onTripChange(latest);
                show(await generateDraft(trip_id, latest.revision));
              })
            }
          >
            重新核对草案
          </button>
        </>
      ) : draft ? (
        <button
          type="button"
          className="primary full"
          disabled={busy || !canApply}
          onClick={() =>
            void perform('正在应用草案…', async () => {
              const updated = await applyDraft(trip_id, {
                draft_id: draft.draft_id,
                revision: draft.revision,
              });
              setPreview({ draft: null, needs_review: false });
              onTripChange(updated);
              setNotice('草案已应用，固定安排已保留。');
            })
          }
        >
          确认应用草案
        </button>
      ) : preview ? (
        <button
          type="button"
          className="primary full draft-generate"
          disabled={busy}
          onClick={() =>
            void perform('正在生成草案…', async () => show(await generateDraft(trip_id, revision)))
          }
        >
          生成一日行程草案
        </button>
      ) : error ? (
        <button
          type="button"
          className="secondary full"
          disabled={busy}
          onClick={() => {
            setError('');
            setRetry((value) => value + 1);
          }}
        >
          重试读取草案
        </button>
      ) : (
        <p role="status">正在读取草案…</p>
      )}
    </section>
  );
}
