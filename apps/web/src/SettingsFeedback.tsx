import type { RadarFeedback, RadarFeedbackClear } from '@nextstop/core';
import { useEffect, useState } from 'react';
import { ApiError, createSession, getRadarHistory, requestJson } from './api.js';
import { radarFeedbackClearValidator, radarFeedbackStatusValidator } from '@nextstop/core';
import { readRadarPointer } from './offline-trip.js';
import { RadarFeedbackNote } from './RadarFeedback.js';

type FeedbackState =
  | { kind: 'loading' }
  | { kind: 'active'; sessionId: string; feedback: RadarFeedback }
  | { kind: 'finished'; result: RadarFeedbackClear['kind'] }
  | { kind: 'error'; message: string };

const feedbackPath = (id: string) => `/api/v1/radar/sessions/${encodeURIComponent(id)}/feedback`;
const messages = {
  none: '当前雷达会话没有可清除的反馈。',
  restored: '已清除本次反馈，并按原条件重新筛选。',
  invalidated: '已清除本次反馈。上次结果已失效，请重新计算推荐。',
} satisfies Record<RadarFeedbackClear['kind'], string>;

export function SettingsFeedback({
  available,
  busy,
  onChanged,
  onClear,
}: {
  available: boolean;
  busy: boolean;
  onChanged: () => void;
  onClear: (action: () => Promise<void>) => Promise<void>;
}) {
  const [state, setState] = useState<FeedbackState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    const { signal } = controller;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        await createSession(signal);
        const id =
          readRadarPointer() ?? (await getRadarHistory(signal))?.view.outcome.binding.session_id;
        const status =
          id &&
          (await requestJson(feedbackPath(id), {}, radarFeedbackStatusValidator.check, signal));
        if (signal.aborted) return;
        setState(
          id && status && status.kind === 'active'
            ? { kind: 'active', sessionId: id, feedback: status.feedback }
            : { kind: 'finished', result: 'none' },
        );
      } catch (error) {
        if (!signal.aborted)
          setState({
            kind: 'error',
            message: error instanceof ApiError ? error.message : '暂时无法读取本次反馈。',
          });
      }
    })();
    return () => controller.abort();
  }, [available, attempt]);

  if (!available) return <p>联网后可以查看和清除本次反馈。</p>;
  switch (state.kind) {
    case 'loading':
      return <p role="status">正在读取本次反馈…</p>;
    case 'finished':
      return <p role="status">{messages[state.result]}</p>;
    case 'error':
      return (
        <>
          <p role="alert">{state.message}</p>
          <button
            className="secondary"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试读取反馈
          </button>
        </>
      );
    case 'active':
      return (
        <>
          <RadarFeedbackNote feedback={state.feedback} />
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void onClear(async () => {
                const result = await requestJson(
                  feedbackPath(state.sessionId),
                  { method: 'DELETE' },
                  radarFeedbackClearValidator.check,
                );
                setState({ kind: 'finished', result: result.kind });
                if (result.kind !== 'none') onChanged();
              })
            }
          >
            清除本次反馈
          </button>
        </>
      );
  }
}
