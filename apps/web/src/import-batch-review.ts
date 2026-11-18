import type { ConfirmBatch, ImportBatch, ImportBatchItem, Wishlist } from '@nextstop/core';

export type ReviewableImage = Extract<ImportBatchItem, { kind: 'ready' | 'failed' }>;
export type Choices = ReadonlyMap<string, { reviewRevision: number; poiId: string }>;
export type ReviewGroup = 'matched' | 'ambiguous' | 'guess' | 'unmatched';

export function groupFor({ review }: ReviewableImage): ReviewGroup {
  const { match, extraction } = review;
  if (extraction.kind === 'guess') return 'guess';
  if (match.kind !== 'results' || !match.candidates.length) return 'unmatched';
  if (
    extraction.kind === 'text' &&
    extraction.confidence === 'high' &&
    match.candidates.length === 1 &&
    match.candidates[0]?.name.trim() === extraction.name.trim()
  )
    return 'matched';
  return 'ambiguous';
}

export function choiceFor(item: ReviewableImage, choices: Choices) {
  const { review } = item;
  if (review.match.kind !== 'results') return undefined;
  const selected = choices.get(item.import_id);
  if (selected?.reviewRevision === review.revision)
    return review.match.candidates.find(({ id }) => id === selected.poiId);
  return groupFor(item) === 'matched' ? review.match.candidates[0] : undefined;
}

export function previewBatch(
  items: ImportBatch['items'],
  choices: Choices,
  wishlist: Wishlist | null,
) {
  const known = new Set(
    wishlist?.places.filter(({ provider }) => provider === 'amap').map(({ poi_id }) => poi_id),
  );
  const selections: ConfirmBatch['selections'] = [];
  const places = new Map<
    string,
    { name: string; address: string; sources: number; known: boolean }
  >();
  let pending = 0;
  for (const item of items) {
    if (item.kind === 'saved' || item.kind === 'skipped') continue;
    const candidate =
      item.kind === 'ready' || item.kind === 'failed' ? choiceFor(item, choices) : undefined;
    if (!candidate) {
      pending += 1;
      continue;
    }
    selections.push({ import_id: item.import_id, poi_id: candidate.id });
    const existing = places.get(candidate.id);
    if (existing) existing.sources += 1;
    else places.set(candidate.id, { ...candidate, sources: 1, known: known.has(candidate.id) });
  }
  const distinct = [...places.values()];
  return {
    selections,
    places,
    pending,
    newCount: wishlist ? distinct.filter((place) => !place.known).length : null,
  };
}
