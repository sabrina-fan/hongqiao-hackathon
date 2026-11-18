import {
  canAdjustDraftEntry,
  draftMoveTarget,
  isDraftLocked,
  type Arrangement,
  type DraftEdit,
  type DraftEntry,
  type TripDay,
  type TripDetail,
  type WishlistPlace,
} from '@nextstop/core';

const MAX_PLACES = 6;
const STAY_MIN = 40;
type Scheduled = Extract<DraftEntry, { kind: 'scheduled' }>;
type Unscheduled = Extract<DraftEntry, { kind: 'unscheduled' }>;
export type DraftPlace = Pick<DraftEntry, 'poi_id' | 'name' | 'address'>;
export type DraftAnchor = Pick<Arrangement, 'start' | 'end' | 'name' | 'address' | 'poi_id'>;
export type WalkMinutes = (
  from: DraftAnchor | DraftPlace,
  to: DraftAnchor | DraftPlace,
) => Promise<number | null>;

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const district = (address: string) =>
  address.replace(/^.*?市/, '').match(/^[^区县]{1,8}[区县]/)?.[0] ?? '';
const city = (name: string) => name.trim().replace(/市$/, '');

function placeOf({ poi_id, name, address }: DraftPlace): DraftPlace {
  return { poi_id, name, address };
}

export function draftCandidates(trip: TripDetail, places: WishlistPlace[]): DraftEntry[] {
  const existingIds = new Set([...trip.arrangements, ...trip.stops].map(({ poi_id }) => poi_id));
  const ordered = places
    .filter(
      (place) =>
        place.name.trim() !== '' &&
        !existingIds.has(place.poi_id) &&
        !trip.arrangements.some(
          ({ name, address }) =>
            name === place.name && address.trim() !== '' && address === place.address,
        ),
    )
    .toSorted(
      (a, b) =>
        district(a.address).localeCompare(district(b.address), 'zh-CN') ||
        a.poi_id.localeCompare(b.poi_id, 'en'),
    );
  let eligible = 0;
  return ordered.map((place) => {
    const reason =
      city(place.city) !== city(trip.day?.destination ?? '')
        ? 'other_city'
        : eligible++ >= MAX_PLACES
          ? 'capacity'
          : 'time_conflict';
    return { ...placeOf(place), kind: 'unscheduled', reason };
  });
}

export function editDraftEntries(entries: DraftEntry[], edit: DraftEdit): DraftEntry[] | null {
  const index = entries.findIndex(({ poi_id }) => poi_id === edit.poi_id);
  const entry = entries[index];
  if (!entry) return null;
  const changed = [...entries];
  switch (edit.kind) {
    case 'lock':
      if (entry.kind !== 'scheduled') return null;
      changed[index] = { ...entry, locked: edit.locked };
      break;
    case 'move': {
      const target = draftMoveTarget(entries, index, edit.direction);
      if (target === null) return null;
      const peer = entries[target];
      if (!peer) return null;
      changed[index] = peer;
      changed[target] = entry;
      break;
    }
    case 'skip':
      if (!canAdjustDraftEntry(entry)) return null;
      changed[index] = { ...placeOf(entry), kind: 'skipped' };
      break;
    case 'restore':
      if (entry.kind !== 'skipped') return null;
      changed[index] = { ...placeOf(entry), kind: 'unscheduled', reason: 'time_conflict' };
      break;
  }
  return changed;
}

type Gap = { start: number; end: number; previous: DraftAnchor | undefined; next?: DraftAnchor };
function gaps(day: TripDay, anchors: DraftAnchor[]): Gap[] {
  const result: Gap[] = [];
  const closes = minutes(day.end);
  let start = minutes(day.start);
  let previous: DraftAnchor | undefined;
  for (const anchor of anchors.toSorted((a, b) => a.start.localeCompare(b.start))) {
    const end = minutes(anchor.start);
    if (end > closes) break;
    if (end > start) result.push({ start, end, previous, next: anchor });
    const after = minutes(anchor.end);
    if (after > start || (after === start && !previous)) {
      start = after;
      previous = anchor;
    }
  }
  if (start < closes) result.push({ start, end: closes, previous });
  return result;
}

async function findSlot({
  day,
  anchors,
  entry,
  earliest,
  latest,
  walk,
}: {
  day: TripDay;
  anchors: DraftAnchor[];
  entry: DraftEntry;
  earliest: number;
  latest: number;
  walk: WalkMinutes;
}): Promise<Scheduled | Unscheduled> {
  let unknownWalk = false;
  const place = placeOf(entry);
  for (const gap of gaps(day, anchors)) {
    const end = Math.min(latest, gap.end);
    if (Math.max(earliest, gap.start) + STAY_MIN > end) continue;
    const incoming = gap.previous ? await walk(gap.previous, place) : 0;
    if (incoming !== null && Math.max(earliest, gap.start + incoming) + STAY_MIN > end) continue;
    const outgoing = gap.next ? await walk(place, gap.next) : 0;
    if (incoming === null || outgoing === null) {
      unknownWalk = true;
      continue;
    }
    const start = Math.max(earliest, gap.start + incoming);
    if (start + STAY_MIN + outgoing <= end) {
      return {
        ...place,
        kind: 'scheduled',
        start: clock(start),
        end: clock(start + STAY_MIN),
        locked: false,
        stay_min: STAY_MIN,
      };
    }
  }
  return {
    ...place,
    kind: 'unscheduled',
    reason: unknownWalk ? 'walking_unknown' : 'time_conflict',
  };
}

export async function scheduleDraft({
  day,
  arrangements,
  entries,
  walk,
}: {
  day: TripDay;
  arrangements: Arrangement[];
  entries: DraftEntry[];
  walk: WalkMinutes;
}): Promise<DraftEntry[]> {
  const anchors: DraftAnchor[] = [...arrangements, ...entries.filter(isDraftLocked)];
  const planned: DraftEntry[] = [];
  let earliest = minutes(day.start);
  for (const [index, entry] of entries.entries()) {
    if (isDraftLocked(entry)) {
      earliest = minutes(entry.end);
      planned.push(entry);
      continue;
    }
    if (!canAdjustDraftEntry(entry)) {
      planned.push(entry);
      continue;
    }
    const nextLock = entries.slice(index + 1).find(isDraftLocked);
    const latest = minutes(nextLock?.start ?? day.end);
    const result = await findSlot({ day, anchors, entry, earliest, latest, walk });
    if (result.kind === 'scheduled') {
      anchors.push(result);
      earliest = minutes(result.end);
    }
    planned.push(result);
  }
  return planned;
}
