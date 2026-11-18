import type { Arrangement, ArrangementInput, TripDay } from '@nextstop/core';
import type { FormEvent } from 'react';

function submitForm(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  return (name: string) => String(fields.get(name) ?? '');
}

function TimeFields({
  start,
  end,
  busy,
}: {
  start: string | undefined;
  end: string | undefined;
  busy: boolean;
}) {
  return (
    <div className="trip-times">
      <label className="field">
        开始时间
        <input name="start" type="time" required disabled={busy} defaultValue={start} />
      </label>
      <label className="field">
        结束时间
        <input name="end" type="time" required disabled={busy} defaultValue={end} />
      </label>
    </div>
  );
}

function Actions({ busy, save, cancel }: { busy: boolean; save: string; cancel: () => void }) {
  return (
    <div className="trip-actions">
      <button type="button" className="text-button" disabled={busy} onClick={cancel}>
        取消
      </button>
      <button type="submit" className="primary mini" disabled={busy}>
        {busy ? '正在保存…' : save}
      </button>
    </div>
  );
}

export function TripDayForm({
  day,
  busy,
  save,
  cancel,
}: {
  day?: TripDay | null;
  busy: boolean;
  save: (day: TripDay) => void;
  cancel: () => void;
}) {
  return (
    <form
      className="panel padded-panel trip-editor"
      onSubmit={(event) => {
        const field = submitForm(event);
        save({
          destination: field('destination').trim(),
          date: field('date'),
          time_zone: field('time_zone').trim(),
          start: field('start'),
          end: field('end'),
        });
      }}
    >
      <h2>{day ? '编辑旅行' : '新建旅行'}</h2>
      <label className="field">
        目的地
        <input
          name="destination"
          required
          disabled={busy}
          maxLength={100}
          defaultValue={day?.destination ?? '苏州'}
        />
      </label>
      <label className="field">
        旅行日期
        <input name="date" type="date" required disabled={busy} defaultValue={day?.date} />
      </label>
      <label className="field">
        时区
        <input
          name="time_zone"
          required
          disabled={busy}
          maxLength={100}
          defaultValue={day?.time_zone ?? 'Asia/Shanghai'}
        />
      </label>
      <TimeFields busy={busy} start={day?.start ?? '09:00'} end={day?.end ?? '20:00'} />
      <Actions busy={busy} save="保存旅行" cancel={cancel} />
    </form>
  );
}

export function ArrangementForm({
  item,
  busy,
  save,
  cancel,
}: {
  item: Arrangement | undefined;
  busy: boolean;
  save: (input: ArrangementInput) => void;
  cancel: () => void;
}) {
  return (
    <form
      className="panel padded-panel trip-editor"
      onSubmit={(event) => {
        const field = submitForm(event);
        save({
          name: field('name').trim(),
          address: field('address'),
          start: field('start'),
          end: field('end'),
          locked: field('locked') === 'on',
        });
      }}
    >
      <h2>{item ? '编辑固定安排' : '添加固定安排'}</h2>
      <label className="field">
        活动名称
        <input name="name" required disabled={busy} maxLength={200} defaultValue={item?.name} />
      </label>
      <TimeFields busy={busy} start={item?.start} end={item?.end} />
      <label className="field">
        地点地址
        <input name="address" disabled={busy} maxLength={500} defaultValue={item?.address} />
      </label>
      <label className="trip-lock">
        <input
          name="locked"
          type="checkbox"
          disabled={busy}
          defaultChecked={item?.locked ?? true}
        />
        锁定安排
      </label>
      <Actions busy={busy} save="保存固定安排" cancel={cancel} />
    </form>
  );
}
