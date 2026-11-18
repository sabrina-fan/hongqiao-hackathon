import { filterWishlist, type SavedPlace, type WishlistFilter } from '@nextstop/core';

export function WishlistList({
  places,
  filter,
  onFilter,
  onSelect,
}: {
  places: SavedPlace[];
  filter: WishlistFilter;
  onFilter: (filter: WishlistFilter) => void;
  onSelect: (place: SavedPlace) => void;
}) {
  const visible = filterWishlist(places, filter);
  const hasStatus = Boolean(filter.visit || filter.schedule || filter.evidence);
  function toggle<Key extends 'visit' | 'schedule' | 'evidence'>(
    key: Key,
    value: NonNullable<WishlistFilter[Key]>,
  ) {
    const next = { ...filter };
    if (next[key] === value) delete next[key];
    else next[key] = value;
    onFilter(next);
  }
  return (
    <>
      <input
        className="wishlist-query"
        type="search"
        aria-label="搜索收藏"
        placeholder="搜索地点、地址或备注"
        value={filter.q ?? ''}
        maxLength={200}
        onChange={(event) => onFilter({ ...filter, q: event.currentTarget.value })}
      />
      <div className="wishlist-filters" role="group" aria-label="收藏筛选">
        <button
          type="button"
          aria-pressed={!hasStatus}
          onClick={() => onFilter({ q: filter.q ?? '' })}
        >
          全部
        </button>
        <button
          type="button"
          aria-pressed={filter.visit === 'unvisited'}
          onClick={() => toggle('visit', 'unvisited')}
        >
          想去
        </button>
        <button
          type="button"
          aria-pressed={filter.visit === 'visited'}
          onClick={() => toggle('visit', 'visited')}
        >
          已去
        </button>
        <button
          type="button"
          aria-pressed={filter.schedule === 'unscheduled'}
          onClick={() => toggle('schedule', 'unscheduled')}
        >
          未安排
        </button>
        <button
          type="button"
          aria-pressed={filter.evidence === 'unknown'}
          onClick={() => toggle('evidence', 'unknown')}
        >
          待核验
        </button>
      </div>
      <div className="library-between">
        <h2>苏州的收藏</h2>
        <small role="status">共 {visible.length} 处</small>
      </div>
      {visible.length === 0 && (
        <p className="note">
          {places.length
            ? '没有符合条件的收藏。试试其他关键词或筛选。'
            : '还没有收藏。可以手动添加地点，或导入攻略截图。'}
        </p>
      )}
      {visible.map((place) => (
        <button
          className="panel wishlist-card"
          key={`${place.provider}:${place.poi_id}`}
          type="button"
          onClick={() => onSelect(place)}
        >
          <span className="library-place-icon" aria-hidden="true">
            ⌖
          </span>
          <span className="wishlist-card-copy">
            <strong>{place.name}</strong>
            <span>{place.address || '地图未提供地址'}</span>
            <small>
              {place.visit === 'visited' ? '已去' : '想去'} ·{' '}
              {place.schedule === 'scheduled' ? '已安排' : '未安排'} · {place.sources.length} 条来源
            </small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      ))}
    </>
  );
}
