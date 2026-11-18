import type { ConfirmBatch, ImportBatch, ImportBatchItem, Wishlist } from '@nextstop/core';
import { useState } from 'react';
import { batchImagePath } from './import-batch-client.js';
import {
  choiceFor,
  groupFor,
  previewBatch,
  type Choices,
  type ReviewableImage,
} from './import-batch-review.js';

export const itemStatus: Record<ImportBatchItem['kind'], string> = {
  processing: '处理中',
  ready: '已处理',
  failed: '处理失败',
  invalid: '图片无效',
  skipped: '已跳过',
  saved: '已收藏',
};

export function imageStatus(item: ImportBatchItem) {
  if (item.kind === 'invalid') return item.reason === 'too_large' ? '超过 5 MB' : '无法读取图片';
  if (item.kind === 'failed') {
    if (item.reason === 'vision') return '识别失败';
    if (item.reason === 'map') return '地图查询失败';
    return '处理已中断';
  }
  if (
    item.kind === 'ready' &&
    item.review.extraction.kind === 'unrecognized' &&
    (item.review.match.kind !== 'results' || !item.review.match.candidates.length)
  )
    return '未识别';
  return itemStatus[item.kind];
}

export type ImageAction = { action: 'remove' | 'skip' } | { action: 'search'; query: string };

function ReviewImage({
  batchId,
  item,
  choices,
  choose,
  edit,
  busy,
}: {
  batchId: string;
  item: ReviewableImage;
  choices: Choices;
  choose: (item: ReviewableImage, poiId: string) => void;
  edit: (action: ImageAction) => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const { extraction, match, source } = item.review;
  const selected = choiceFor(item, choices);
  const candidates = match.kind === 'results' ? match.candidates : [];
  const title =
    extraction.kind === 'text'
      ? `识别到「${extraction.name}」`
      : extraction.kind === 'guess'
        ? `可能想去 · ${extraction.name}`
        : item.name || '来源截图';
  const image = batchImagePath(batchId, item.import_id);
  const group = groupFor(item);
  const badge = { matched: '已匹配', ambiguous: '有歧义', guess: '待确认', unmatched: '未匹配' }[
    group
  ];
  const controls = (
    <>
      {source.kind === 'image' && source.excerpt && (
        <p className="library-excerpt">「{source.excerpt}」</p>
      )}
      {extraction.kind === 'guess' && <p className="muted">照片推测，请核对名称和地址后选择。</p>}
      {extraction.kind === 'text' && extraction.confidence === 'low' && (
        <p className="muted">识别把握较低，请对照截图。</p>
      )}
      {!candidates.length && (
        <p className="muted">
          {item.kind === 'failed'
            ? `${imageStatus(item)}，也可手动搜索。`
            : '未匹配到地点，可以手动补录。'}
        </p>
      )}
      {candidates.length > 0 && (
        <fieldset className="library-options" disabled={busy}>
          <legend>{candidates.length > 1 ? '请选择正确地点与地址' : '核对地图候选'}</legend>
          {candidates.map((place) => (
            <label className="option" key={place.id}>
              <input
                type="radio"
                name={item.import_id}
                checked={selected?.id === place.id}
                onChange={() => choose(item, place.id)}
              />
              <span>
                <strong>{place.name}</strong>
                <small>{place.address || '地图未提供地址'}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <details>
        <summary>{candidates.length ? '手动更换地点' : '手动补录地点'}</summary>
        <form
          className="library-search"
          onSubmit={(event) => {
            event.preventDefault();
            edit({ action: 'search', query: query.trim() });
          }}
        >
          <label htmlFor={item.import_id}>搜索苏州地点</label>
          <div>
            <input
              id={item.import_id}
              type="search"
              value={query}
              maxLength={100}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="输入地点名称"
              disabled={busy}
            />
            <button className="secondary" type="submit" disabled={busy || !query.trim()}>
              搜索
            </button>
          </div>
        </form>
      </details>
      <div className="batch-row-actions">
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => edit({ action: 'skip' })}
        >
          跳过
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => edit({ action: 'remove' })}
        >
          删除
        </button>
      </div>
    </>
  );
  return (
    <article className="panel library-review batch-review-card">
      <div className="batch-review-source">
        <a href={image} target="_blank" rel="noreferrer" aria-label={`查看原图 ${item.name}`}>
          <img src={image} alt="" loading="lazy" />
        </a>
        <div>
          <h3>{title}</h3>
          <a href={image} target="_blank" rel="noreferrer">
            查看来源截图
          </a>
        </div>
        <span className={`badge ${group === 'matched' ? 'green' : ''}`}>{badge}</span>
      </div>
      {controls}
    </article>
  );
}

export function BatchReview({
  batch,
  choices,
  choose,
  wishlist,
  edit,
  confirm,
  busy,
  onBack,
}: {
  batch: ImportBatch;
  choices: Choices;
  choose: (item: ReviewableImage, poiId: string) => void;
  wishlist: Wishlist | null;
  edit: (item: ImportBatchItem, action: ImageAction) => void;
  confirm: (input: ConfirmBatch) => void;
  onBack: () => void;
  busy: boolean;
}) {
  const groups: Record<ReturnType<typeof groupFor>, ReviewableImage[]> = {
    matched: [],
    ambiguous: [],
    guess: [],
    unmatched: [],
  };
  const sections = [
    { items: groups.ambiguous, label: '需要你确认' },
    { items: groups.guess, label: '可能想去 · 照片推测' },
    { items: groups.unmatched, label: '未匹配' },
  ];
  for (const item of batch.items) {
    if (item.kind === 'ready' || item.kind === 'failed') groups[groupFor(item)].push(item);
  }
  const matchedByPlace = Map.groupBy(
    groups.matched,
    (item) => choiceFor(item, choices)?.id ?? item.import_id,
  );
  const reviewItem = (item: ReviewableImage) => (
    <ReviewImage
      key={item.import_id}
      batchId={batch.batch_id}
      item={item}
      choices={choices}
      choose={choose}
      edit={(action) => edit(item, action)}
      busy={busy}
    />
  );
  const { newCount, pending, places, selections } = previewBatch(batch.items, choices, wishlist);
  const saved = batch.items.filter(({ kind }) => kind === 'saved').length;
  const skipped = batch.items.filter(({ kind }) => kind === 'skipped').length;
  return (
    <>
      <div className="batch-review-results">
        <ul className="batch-summary">
          <li>
            <strong>{groups.matched.length}</strong>已匹配
          </li>
          <li>
            <strong>{groups.ambiguous.length + groups.guess.length}</strong>待确认
          </li>
          <li>
            <strong>{groups.unmatched.length}</strong>未匹配
          </li>
        </ul>
        <div className="note batch-review-count" role="status">
          <strong>
            实际新增 {newCount ?? '—'} 处 · 待处理 {pending} 项
          </strong>
          {(saved > 0 || skipped > 0) && (
            <p>
              已保存 {saved} 张来源 · 已跳过 {skipped} 项
            </p>
          )}
          <p>重复地点合为一条收藏，每张来源都会保留。你可以先确认已选地点。</p>
        </div>
        {matchedByPlace.size > 0 && (
          <section className="batch-review-group">
            <h2>已匹配地点（{matchedByPlace.size}）</h2>
            <div className="panel batch-matched-list">
              {[...matchedByPlace].map(([key, items]) => {
                const first = items[0];
                if (!first) return null;
                const place = choiceFor(first, choices);
                return (
                  <details key={key} className="batch-matched-place">
                    <summary>
                      <img
                        src={batchImagePath(batch.batch_id, first.import_id)}
                        alt=""
                        loading="lazy"
                      />
                      <span>
                        <strong>{place?.name ?? first.name}</strong>
                        <small>
                          来源截图 × {items.length}
                          {place?.address && ` · ${place.address}`}
                        </small>
                      </span>
                      <span className="badge green">核对</span>
                    </summary>
                    {items.map(reviewItem)}
                  </details>
                );
              })}
            </div>
          </section>
        )}
        {sections.map(
          ({ items, label }) =>
            items.length > 0 && (
              <section className="batch-review-group" key={label}>
                <h2>
                  {label}（{items.length}）
                </h2>
                {items.map(reviewItem)}
              </section>
            ),
        )}
        {places.size > 0 && (
          <div className="panel batch-confirm-summary">
            <h2>本次保存预览</h2>
            <ul>
              {[...places].map(([id, place]) => (
                <li key={id}>
                  <strong>{place.name}</strong>
                  <span>
                    {place.address || '地图未提供地址'} · {place.sources} 张来源
                    {wishlist && (place.known ? ' · 已有收藏' : ' · 新增')}
                  </span>
                </li>
              ))}
            </ul>
            <p>待处理 {pending} 项将继续留在批次中。</p>
          </div>
        )}
        <button className="secondary full" type="button" disabled={busy} onClick={onBack}>
          返回灵感库
        </button>
      </div>
      {selections.length > 0 && (
        <button
          className="primary full cta"
          type="button"
          disabled={busy || newCount === null}
          onClick={() => {
            if (newCount !== null)
              confirm({ revision: batch.revision, new_count: newCount, selections });
          }}
        >
          确认并加入灵感库{newCount === null ? '' : `（新增 ${newCount} 处）`}
        </button>
      )}
    </>
  );
}
