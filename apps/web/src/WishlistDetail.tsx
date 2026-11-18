import { useEffect, useState } from 'react';
import type { EditWishlist, SavedPlace, WishlistPlace } from '@nextstop/core';
import { ApiError } from './api.js';
import {
  editSavedPlace,
  getSavedPlace,
  importImagePath,
  removeSavedPlace,
} from './wishlist-client.js';

type PlaceKey = Pick<WishlistPlace, 'provider' | 'poi_id'>;
type DetailState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; place: SavedPlace };
const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : '服务暂不可用，请重试。';
const evidenceLabel: Record<SavedPlace['evidence'], string> = {
  unknown: '待核验',
  verified: '已核验',
  estimated: '估计',
  stale: '已过期',
};

export function WishlistDetail({ placeKey, onBack }: { placeKey: PlaceKey; onBack: () => void }) {
  const { provider, poi_id } = placeKey;
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void getSavedPlace({ provider, poi_id }, controller.signal).then(
      (place) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'ready', place });
        setNote(place.note);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: 'error', message: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [provider, poi_id, retry]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function update(edit: EditWishlist, message: string) {
    void run(async () => {
      const place = await editSavedPlace(placeKey, edit);
      setState({ kind: 'ready', place });
      if (edit.note !== undefined) setNote(place.note);
      setNotice(message);
    });
  }

  return (
    <section className="library-screen">
      <header className="bar library-heading">
        <button
          className="library-back"
          type="button"
          aria-label="返回灵感库"
          disabled={busy}
          onClick={onBack}
        >
          ‹
        </button>
        <h1>地点详情</h1>
      </header>
      {state.kind === 'loading' && <p role="status">正在读取地点…</p>}
      {state.kind === 'error' && (
        <div className="note">
          <p role="alert">{state.message}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试读取地点
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          <PlaceFacts place={state.place} />
          <form
            className="panel wishlist-detail-panel"
            onSubmit={(event) => {
              event.preventDefault();
              update({ note: note.trim() }, '已保存备注');
            }}
          >
            <label htmlFor="wishlist-note">收藏备注</label>
            <textarea
              id="wishlist-note"
              value={note}
              maxLength={500}
              rows={2}
              disabled={busy}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <button
              type="submit"
              className="secondary"
              disabled={busy || note.trim() === state.place.note}
            >
              保存备注
            </button>
          </form>
          {failure && (
            <p role="alert" className="note">
              {failure}
            </p>
          )}
          {notice && (
            <p role="status" className="note">
              {notice}
            </p>
          )}
          {confirmRemove ? (
            <div className="panel wishlist-detail-panel">
              <p>从灵感库移除「{state.place.name}」？已保存的行程和导入记录仍会保留。</p>
              <div className="library-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setConfirmRemove(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await removeSavedPlace(placeKey);
                      onBack();
                    })
                  }
                >
                  确认移除
                </button>
              </div>
            </div>
          ) : (
            <div className="library-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                移除收藏
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => {
                  const visited = state.place.visit === 'visited';
                  update(
                    { visit: visited ? 'unvisited' : 'visited' },
                    visited ? '已标为想去' : '已标为已去',
                  );
                }}
              >
                {state.place.visit === 'visited' ? '改为想去' : '标为已去'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PlaceFacts({ place }: { place: SavedPlace }) {
  return (
    <div className="panel wishlist-detail-panel">
      <p className="wishlist-eyebrow">苏州 · 来自灵感库</p>
      <h2>{place.name}</h2>
      <p>{place.address || '地图未提供地址'}</p>
      <p className="wishlist-muted">高德地点 · {place.poi_id}</p>
      <div className="wishlist-status">
        <span>{place.visit === 'visited' ? '已去' : '想去'}</span>
        <span>{place.schedule === 'scheduled' ? '已安排' : '未安排'}</span>
        <span>{evidenceLabel[place.evidence]}</span>
      </div>
      <dl className="wishlist-evidence">
        <div>
          <dt>营业信息</dt>
          <dd>待核验</dd>
        </div>
        <div>
          <dt>门票与预约</dt>
          <dd>待核验</dd>
        </div>
        <div>
          <dt>路线与用时</dt>
          <dd>需从出发地重新计算</dd>
        </div>
      </dl>
      <h3>收藏来源（{place.sources.length}）</h3>
      <ul className="wishlist-sources">
        {place.sources.map((source, index) => (
          <li key={source.import_id}>
            {source.kind === 'image' ? (
              <>
                <a href={importImagePath(source.import_id)} target="_blank" rel="noreferrer">
                  查看来源截图 {index + 1}
                </a>
                {source.excerpt && <p>「{source.excerpt}」</p>}
              </>
            ) : (
              '手动添加'
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
