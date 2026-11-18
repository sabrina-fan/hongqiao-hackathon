import type { ImportReview, Wishlist, WishlistFilter, WishlistPlace } from '@nextstop/core';
import { useEffect, useState } from 'react';
import { ApiError, readWithGuestSession } from './api.js';
import { ImportBatchPanel } from './ImportBatchPanel.js';
import { WishlistDetail } from './WishlistDetail.js';
import { WishlistList } from './WishlistList.js';
import { confirmImport, getWishlist, importImagePath, searchImport } from './wishlist-client.js';
import './library.css';

type Screen =
  | { kind: 'library'; saved?: string }
  | { kind: 'detail'; placeKey: Pick<WishlistPlace, 'provider' | 'poi_id'> }
  | { kind: 'upload' }
  | { kind: 'review'; review: ImportReview | null };
type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; value: Wishlist }
  | { kind: 'error'; message: string };
function messageOf(error: unknown) {
  return error instanceof ApiError ? error.message : '服务暂不可用，请重试。';
}
function titleOf(review: ImportReview | null) {
  if (!review) return '手动补录地点';
  const { extraction } = review;
  switch (extraction.kind) {
    case 'text':
      return `识别到「${extraction.name}」`;
    case 'guess':
      return `可能想去 · ${extraction.name}`;
    case 'vision_unavailable':
      return '暂时无法识别截图，请手动搜索地点。';
    case 'unrecognized':
      return '未识别到地点，请手动搜索。';
    case 'manual':
      return '手动补录地点';
  }
}

export function LibraryPanel({
  canImport,
  canRead,
  canRecognize,
}: {
  canImport: boolean;
  canRead: boolean;
  canRecognize: boolean;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: 'library' });
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [filter, setFilter] = useState<WishlistFilter>({});
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState('');
  const [pending, setPending] = useState('');
  const busy = Boolean(pending);
  const [failure, setFailure] = useState('');
  const screenKind = screen.kind;

  useEffect(() => {
    document.getElementById('screen')?.scrollTo(0, 0);
    if (screenKind !== 'library' || !canRead) return;
    const controller = new AbortController();
    setList({ kind: 'loading' });
    void (async () => {
      try {
        const value = await readWithGuestSession(
          () => getWishlist(controller.signal),
          controller.signal,
        );
        if (!controller.signal.aborted) setList({ kind: 'ready', value });
      } catch (error) {
        if (!controller.signal.aborted) setList({ kind: 'error', message: messageOf(error) });
      }
    })();
    return () => controller.abort();
  }, [screenKind, canRead, retry]);

  function navigate(next: Screen) {
    if (next.kind === 'library') setList({ kind: 'loading' });
    setFailure('');
    setChoice('');
    setQuery('');
    setScreen(next);
  }
  async function run(message: string, action: () => Promise<void>) {
    if (busy) return;
    setPending(message);
    setFailure('');
    try {
      await action();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setPending('');
    }
  }
  if (screen.kind === 'library') {
    return (
      <section className="library-screen wishlist-screen">
        <header className="bar">
          <h1>我的灵感库</h1>
        </header>
        <p className="library-city">⌖ 苏州</p>
        {screen.saved && (
          <p className="note" role="status">
            已收藏 {screen.saved}
          </p>
        )}
        {canRead && list.kind === 'loading' && <p role="status">正在读取收藏…</p>}
        {canRead && list.kind === 'error' && (
          <div className="note">
            <p role="alert">{list.message}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              重试读取收藏
            </button>
          </div>
        )}
        {list.kind === 'ready' && (
          <WishlistList
            places={list.value.places}
            filter={filter}
            onFilter={setFilter}
            onSelect={({ provider, poi_id }) =>
              navigate({ kind: 'detail', placeKey: { provider, poi_id } })
            }
          />
        )}
        {canImport && list.kind === 'ready' ? (
          <div className="library-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => navigate({ kind: 'review', review: null })}
            >
              ＋ 手动添加
            </button>
            <button className="primary" type="button" onClick={() => navigate({ kind: 'upload' })}>
              ⇧ 导入攻略截图
            </button>
          </div>
        ) : (
          !canImport && <p className="note">导入暂不可用，请检查地图服务配置。</p>
        )}
        {list.kind === 'ready' && list.value.places.length > 0 && (
          <a className="secondary full" href="#trip">
            前往行程生成草案
          </a>
        )}
      </section>
    );
  }

  if (screen.kind === 'detail') {
    return (
      <WishlistDetail placeKey={screen.placeKey} onBack={() => navigate({ kind: 'library' })} />
    );
  }

  const back = (
    <button
      className="library-back"
      type="button"
      aria-label="返回灵感库"
      disabled={busy}
      onClick={() => navigate({ kind: 'library' })}
    >
      ‹
    </button>
  );
  if (screen.kind === 'upload') {
    return (
      <ImportBatchPanel
        canRecognize={canRecognize}
        onBack={() => navigate({ kind: 'library' })}
        onManual={() => navigate({ kind: 'review', review: null })}
      />
    );
  }

  const { review } = screen;
  const candidates = review?.match.kind === 'results' ? review.match.candidates : [];
  const source = review?.source;
  return (
    <section className="library-screen">
      <header className="bar library-heading">
        {back}
        <h1>确认识别的地点</h1>
      </header>
      <div className="panel library-review">
        <div className="library-between">
          <h2>{titleOf(review)}</h2>
          {source?.kind === 'image' && (
            <a href={importImagePath(source.import_id)} target="_blank" rel="noreferrer">
              查看来源截图
            </a>
          )}
        </div>
        {source?.kind === 'image' && source.excerpt && (
          <p className="library-excerpt">来源片段「{source.excerpt}」</p>
        )}
        {review?.extraction.kind === 'guess' && (
          <p className="note">这是根据照片猜测的地标，请核对地址后再确认。</p>
        )}
        {review?.extraction.kind === 'text' && review.extraction.confidence === 'low' && (
          <p className="note">识别把握较低，请对照截图核对地点。</p>
        )}
        {review?.match.kind === 'map_unavailable' && (
          <p role="alert">地图服务暂不可用。请稍后手动搜索。</p>
        )}
        {review?.match.kind === 'results' && !candidates.length && (
          <p className="note">未匹配到苏州的地点。试试更完整的名称。</p>
        )}
        {candidates.length > 0 && (
          <fieldset className="library-options" disabled={busy}>
            <legend>
              {candidates.length > 1 ? '有歧义 · 请选择正确地址' : '请核对地图候选地址'}
            </legend>
            {candidates.map((place) => (
              <label className="option" key={place.id}>
                <input
                  type="radio"
                  name="wishlist-place"
                  checked={choice === place.id}
                  onChange={() => setChoice(place.id)}
                />
                <span>
                  <strong>{place.name}</strong>
                  <small>{place.address || '地图未提供地址'}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <form
          className="library-search"
          onSubmit={(event) => {
            event.preventDefault();
            setChoice('');
            void run('正在搜索地点…', async () => {
              const updated = await searchImport(query.trim(), review?.import_id);
              setScreen({ kind: 'review', review: updated });
            });
          }}
        >
          <label htmlFor="library-query">手动搜索苏州地点</label>
          <div>
            <input
              id="library-query"
              type="search"
              value={query}
              maxLength={100}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="输入地点名称"
              disabled={busy}
            />
            <button className="secondary" type="submit" disabled={!query.trim() || busy}>
              搜索
            </button>
          </div>
        </form>
      </div>
      <div role="status">{pending && <p className="note">{pending}</p>}</div>
      {failure && <p role="alert">{failure}</p>}
      <p className="note">同一地点会合并为一个收藏，保留每次导入的来源。</p>
      <button
        className="primary full cta"
        type="button"
        disabled={!choice || busy}
        onClick={() => {
          if (!review || !choice) return;
          void run('正在保存收藏…', async () => {
            const saved = await confirmImport(review.import_id, {
              revision: review.revision,
              provider: 'amap',
              poi_id: choice,
            });
            navigate({ kind: 'library', saved: saved.name });
          });
        }}
      >
        确认并加入灵感库
      </button>
    </section>
  );
}
