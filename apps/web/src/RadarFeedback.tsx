import { useId, useRef } from 'react';
import type { RadarFeedback } from '@nextstop/core';

const reasons = {
  too_far: { label: '太远', effect: '只推荐去程更短且仍来得及的地点。' },
  too_expensive: { label: '太贵', effect: '优先参考价更低的地点，价格未知的地点仍可展示。' },
  not_interested: { label: '不感兴趣', effect: '已排除这个地点，并降低同类地点的优先级。' },
  less_walking: {
    label: '不想走路',
    effect: '已重新核验步行路线，去程和下一段合计不超过 1.5 公里。',
  },
} satisfies Record<RadarFeedback['reason'], { label: string; effect: string }>;

export function RadarFeedbackNote({ feedback }: { feedback: RadarFeedback }) {
  const { reason, place } = feedback;
  return (
    <p className="note radar-feedback-note" role="status">
      <strong>本次调整 · {reasons[reason].label}</strong>
      <span>
        已跳过{place.name}。{' '}
        {reason === 'too_expensive' && feedback.budget_yuan !== undefined
          ? `已筛除参考价超过 ${feedback.budget_yuan} 元的地点，价格未知的地点仍可展示。`
          : reasons[reason].effect}
      </span>
    </p>
  );
}

export function RadarFeedbackSheet({
  name,
  onReject,
  disabled,
}: {
  name: string;
  onReject: (reason: RadarFeedback['reason']) => void;
  disabled: boolean;
}) {
  const title = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  function choose(reason: RadarFeedback['reason']) {
    sheet.current?.close();
    onReject(reason);
  }
  return (
    <>
      <button
        className="secondary"
        type="button"
        disabled={disabled}
        onClick={() => sheet.current?.showModal()}
      >
        换一个
      </button>
      <dialog ref={sheet} className="place-sheet radar-feedback-sheet" aria-labelledby={title}>
        <h2 id={title}>为什么想换一个？</h2>
        <p>当前选择 · {name}</p>
        <div className="radar-feedback-reasons">
          <button className="secondary" type="button" onClick={() => choose('too_far')}>
            {reasons.too_far.label}
          </button>
          <button className="secondary" type="button" onClick={() => choose('too_expensive')}>
            {reasons.too_expensive.label}
          </button>
          <button className="secondary" type="button" onClick={() => choose('not_interested')}>
            {reasons.not_interested.label}
          </button>
          <button className="secondary" type="button" onClick={() => choose('less_walking')}>
            {reasons.less_walking.label}
          </button>
        </div>
        <button className="text-button" type="button" onClick={() => sheet.current?.close()}>
          取消
        </button>
      </dialog>
    </>
  );
}
