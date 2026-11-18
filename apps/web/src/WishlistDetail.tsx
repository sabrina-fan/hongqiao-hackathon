import { useEffect, useState } from 'react';
import type { EditWishlist, PlaceOption, SavedPlace, WishlistPlace } from '@nextstop/core';
import { ApiError } from './api.js';
import { PlaceField } from './PlaceField.js';
import {
  correctSavedPlace,
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
  const [correcting, setCorrecting] = useState(false);
  const [replacement, setReplacement] = useState<PlaceOption | null>(null);
  const effectiveKey = state.kind === 'ready' ? state.place : placeKey;
  const [pending, setPending] = useState('');
  const busy = Boolean(pending);
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

  async function run(message: string, action: () => Promise<void>) {
    if (busy) return;
    setPending(message);
    setFailure('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending('');
    }
  }

  function update(edit: EditWishlist, message: string) {
    void run(edit.note !== undefined ? '正在保存备注…' : '正在更新访问状态…', async () => {
      const place = await editSavedPlace(effectiveKey, edit);
      setState({ kind: 'ready', place });
      if (edit.note !== undefined) setNote(place.note);
      setNotice(message);
    });
  }

  return (
    <section className="library-screen wishlist-detail-screen">
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
      {state.kind === 'ready' && (
        <div className="wishlist-cover">
          <img src="/art/suzhou-canal.webp" alt="" />
          <small>苏州水巷 · 插图</small>
        </div>
      )}
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
          {correcting ? (
            <section className="panel wishlist-detail-panel">
              <PlaceField
                id="wishlist-replacement"
                label="搜索正确地点"
                placeholder="输入名称，核对地址"
                value={replacement}
                disabled={busy}
                onSelect={setReplacement}
                onSessionExpired={() => false}
              />
              <p>更正会更新收藏的地图地点和地址。已保存的行程仍保留原有安排。</p>
              <div className="library-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setCorrecting(false);
                    setReplacement(null);
                  }}
                >
                  取消更正
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !replacement}
                  onClick={() => {
                    if (!replacement) return;
                    void run('正在保存地点更正…', async () => {
                      const place = await correctSavedPlace(effectiveKey, {
                        query: replacement.name,
                        poi_id: replacement.id,
                      });
                      setState({ kind: 'ready', place });
                      setCorrecting(false);
                      setReplacement(null);
                      setNotice('地点更正已保存');
                    });
                  }}
                >
                  确认更正
                </button>
              </div>
            </section>
          ) : (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setCorrecting(true)}
            >
              更正地图地点
            </button>
          )}
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
          <div role="status">
            {(pending || notice) && <p className="note">{pending || notice}</p>}
          </div>
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
                    void run('正在移除收藏…', async () => {
                      await removeSavedPlace(effectiveKey);
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
    <div className="panel wishlist-detail-panel wishlist-facts">
      <div className="library-between wishlist-facts-heading">
        <h2>{place.name}</h2>
        <span className="badge green">来自灵感库</span>
      </div>
      <div className="wishlist-status">
        <span>{place.visit === 'visited' ? '已去' : '想去'}</span>
        <span>{place.schedule === 'scheduled' ? '已安排' : '未安排'}</span>
        <span>{evidenceLabel[place.evidence]}</span>
      </div>
      <p className="wishlist-address">⌖ {place.address || '地图未提供地址'}</p>
      <p className="wishlist-muted">高德地点 · {place.poi_id}</p>
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
