import { compile } from '@earendil-works/pi-schema';
import {
  fitsTimeWindow,
  liveOriginId,
  radarWindow,
  type FixedStop,
  type ProposalBinding,
  type RadarCandidate,
  type RadarExclusion,
  type RadarOutcome,
  type RadarRequest,
  type RadarView,
} from '@nextstop/core';
import { readWishlist } from '../wishlist/store.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { MapFault, type RadarMap } from './amap.js';
import { RadarFault, WalkingEvidenceSchema } from './evidence.js';
import type { RecallSnapshot, Source, VerifiedCandidate } from './recall-snapshot.js';

const walkingEvidence = compile(WalkingEvidenceSchema);
const candidateLimit = 6;
const minute = 60_000;
const ttl = 5 * minute;

type Pick = Extract<RadarOutcome, { kind: 'recommendations' }>['best'];
type Screened = { pick: Pick; candidate: RadarCandidate };

function samePoint(
  a: NonNullable<VerifiedCandidate['outbound']['markers']>['origin'],
  b: typeof a,
) {
  return a.longitude === b.longitude && a.latitude === b.latitude;
}

export async function recallCandidates({
  runtime,
  map,
  request,
  startedAt,
  fixed,
  now,
}: {
  runtime: UserRuntime;
  map: RadarMap;
  request: RadarRequest;
  startedAt: number;
  fixed: FixedStop | null;
  now: () => number;
}): Promise<RecallSnapshot> {
  if (!map.resolveOrigin || !map.nearby) throw new MapFault('MAP_UNAVAILABLE');
  const { places: saved } = await readWishlist(runtime, { visit: 'unvisited' });
  const signal = AbortSignal.timeout(15_000);
  const location =
    'position' in request ? { position: request.position } : { origin_id: request.origin_id };
  const origin = await map.resolveOrigin(location, signal);
  if (origin.place.id !== ('origin_id' in location ? location.origin_id : liveOriginId))
    throw new MapFault('MAP_UNAVAILABLE');
  const nearby = await map.nearby(origin, signal);
  const pool = new Map<string, { place: RadarCandidate['place']; sources: Source[] }>();
  const add = (place: RadarCandidate['place'], source: Source) => {
    if (place.id === origin.place.id) return;
    const existing = pool.get(place.id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else pool.set(place.id, { place, sources: [source] });
  };
  for (const place of saved)
    add({ id: place.poi_id, name: place.name, address: place.address }, 'wishlist');
  for (const place of nearby) add(place, 'nearby');
  // Split the route budget between the two sources before filling unused slots.
  const entries = [...pool.values()];
  const priority = new Set([
    ...entries.filter(({ sources }) => sources.includes('wishlist')).slice(0, 3),
    ...entries.filter(({ sources }) => sources.includes('nearby')).slice(0, 3),
    ...entries,
  ]);
  const verified: VerifiedCandidate[] = [];
  const excluded: RadarExclusion[] = [];
  for (const { place, sources } of [...priority].slice(0, candidateLimit)) {
    try {
      const outbound = await map.walk({ ...location, poi_id: place.id }, signal, origin);
      if (
        !walkingEvidence.check(outbound) ||
        outbound.origin.id !== origin.place.id ||
        outbound.destination.id !== place.id ||
        (outbound.markers && !samePoint(outbound.markers.origin, origin.point))
      )
        throw new MapFault('MAP_UNAVAILABLE');
      const onward =
        fixed && Date.parse(fixed.starts_at) > startedAt
          ? await map.walkToFixed({ candidate: outbound, fixed }, signal)
          : null;
      if (
        onward &&
        (!walkingEvidence.check(onward) ||
          onward.origin.id !== place.id ||
          onward.destination.id !== fixed?.arrangement_id ||
          onward.destination.address !== fixed.address ||
          (outbound.markers &&
            (!onward.markers || !samePoint(outbound.markers.destination, onward.markers.origin))))
      )
        throw new MapFault('MAP_UNAVAILABLE');
      verified.push({ sources, outbound, onward });
    } catch (error) {
      if (
        !(error instanceof MapFault) ||
        (error.code !== 'PLACE_NOT_FOUND' && error.code !== 'ROUTE_UNVERIFIED')
      )
        throw error;
      excluded.push({ place, reason: 'route_unverified' });
    }
  }
  return {
    origin: origin.place,
    manual_min: request.available_min,
    started_ms: startedAt,
    scanned_at: new Date(now()).toISOString(),
    fixed,
    verified,
    excluded,
    ...(request.fixed_mode ? { fixed_mode: request.fixed_mode } : {}),
    ...(request.preference ? { preference: request.preference } : {}),
  };
}

export function openingCovers(hours: string, arrival: number, stay: number) {
  if (/^(?:休息|暂停营业|不营业|闭馆|closed)$/i.test(hours.trim())) return false;
  const time = (Math.floor(arrival / minute) + 8 * 60) % (24 * 60);
  const periods = hours.split(/[,，;；、]/);
  const matches = periods.map((period) =>
    /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-4]):([0-5]\d)\s*$/.exec(period),
  );
  if (matches.some((match) => !match)) return true;
  return matches.some((match) => {
    if (!match) return false;
    const [, h1, m1, h2, m2] = match;
    const start = Number(h1) * 60 + Number(m1);
    const end = Number(h2) * 60 + Number(m2);
    return end > start
      ? time >= start && time + stay <= end
      : (time >= start && time + stay <= end + 1440) || time + stay <= end;
  });
}

function earliestEvidence({ outbound, onward }: VerifiedCandidate) {
  return Math.min(
    Date.parse(outbound.fetched_at),
    Date.parse(onward?.fetched_at ?? outbound.fetched_at),
  );
}

export function screenRecall(snapshot: RecallSnapshot, at: number) {
  const { fixed, manual_min, started_ms, origin } = snapshot;
  const window = radarWindow({
    started_ms,
    manual_min,
    fixed_ms: fixed ? Date.parse(fixed.starts_at) : null,
  });
  const stay = fixed ? 40 : 20;
  const buffer = fixed ? 10 : 0;
  const maxWalk = snapshot.preference === 'short_walk' ? 1500 : 5000;
  const feasible: Screened[] = [];
  const excluded = [...snapshot.excluded];
  for (const entry of snapshot.verified) {
    const { outbound, onward, sources } = entry;
    const place = outbound.destination;
    const facts = outbound.facts ?? {};
    const first = earliestEvidence(entry);
    const last = Math.max(
      Date.parse(outbound.fetched_at),
      Date.parse(onward?.fetched_at ?? outbound.fetched_at),
    );
    const time = {
      travel_to_min: outbound.travel_min,
      travel_after_min: onward?.travel_min ?? 0,
      stay_min: stay,
      buffer_min: buffer,
    };
    const total = time.travel_to_min + time.travel_after_min + stay + buffer;
    let reason: RadarExclusion['reason'] | null = null;
    if (at < last || at >= first + ttl) reason = 'route_unverified';
    else if (facts.booking?.state === 'required') reason = 'booking_required';
    else if (
      facts.opening &&
      !openingCovers(facts.opening.today, at + outbound.travel_min * minute, stay)
    )
      reason = 'closed';
    else if (
      (fixed && !onward) ||
      outbound.distance_m > maxWalk ||
      (onward?.distance_m ?? 0) > 5000 ||
      !fitsTimeWindow({ ...time, available_min: (window.deadline_ms - at) / minute })
    )
      reason = 'time_or_distance';
    if (reason) {
      excluded.push({ place, reason });
      continue;
    }
    const next = onward?.markers?.destination;
    feasible.push({
      candidate: {
        place,
        sources,
        facts,
        ...(outbound.markers
          ? { markers: { ...outbound.markers, ...(next ? { next } : {}) } }
          : {}),
        remaining_min: window.available_min - total,
        valid_until: new Date(
          Math.min(first + ttl, window.deadline_ms - total * minute + 1),
        ).toISOString(),
      },
      pick: {
        choice: {
          poi_id: place.id,
          reason_code: sources.includes('wishlist') ? 'saved_fit' : 'short_detour',
          reason_text: sources.includes('wishlist')
            ? '这是你想去的收藏，步行和停留都能排进空档。'
            : fixed
              ? '这处附近地点可步行到达，停留后仍能赶上固定安排。'
              : '这处附近地点可步行到达，能利用现在的空档。',
        },
        travel_to_min: outbound.travel_min,
        travel_to_next_min: onward?.travel_min ?? null,
        stay_min_estimate: stay,
        buffer_min: buffer,
        evidence: {
          provider: 'amap',
          fetched_at: new Date(first).toISOString(),
          status: 'estimated',
        },
      },
    });
  }
  feasible.sort((a, b) => {
    const saved =
      Number(b.candidate.sources.includes('wishlist')) -
      Number(a.candidate.sources.includes('wishlist'));
    return (
      (snapshot.preference === 'short_walk'
        ? a.pick.travel_to_min - b.pick.travel_to_min
        : saved) ||
      b.candidate.remaining_min - a.candidate.remaining_min ||
      a.candidate.place.id.localeCompare(b.candidate.place.id)
    );
  });
  const recommended = feasible.slice(0, 3);
  const selected = new Set(
    recommended.map(({ candidate }) => candidate.facts.category).filter(Boolean),
  );
  if (recommended.length === 3 && selected.size < 2) {
    const categories = new Set<string>();
    const diverse = feasible.filter(({ candidate: { facts } }) => {
      if (!facts.category || categories.has(facts.category) || categories.size === 2) return false;
      categories.add(facts.category);
      return true;
    });
    const [first] = feasible;
    if (first && diverse.length === 2) {
      const chosen = new Set([first, ...diverse]);
      for (const option of feasible) {
        if (chosen.size === 3) break;
        chosen.add(option);
      }
      return {
        origin,
        window,
        feasible: feasible.filter((option) => chosen.has(option)),
        eligible: feasible,
        excluded,
      };
    }
  }
  return { origin, window, feasible: recommended, eligible: feasible, excluded };
}

export function recallView(snapshot: RecallSnapshot, outcome: RadarOutcome): RadarView {
  const { origin, window, feasible, excluded } = screenRecall(
    snapshot,
    Date.parse(snapshot.scanned_at),
  );
  const [first] = feasible;
  if (
    outcome.kind === 'empty'
      ? first !== undefined
      : !first ||
        [outcome.best, ...outcome.alternatives].map(({ choice }) => choice.poi_id).join('|') !==
          feasible.map(({ candidate }) => candidate.place.id).join('|')
  )
    throw new RadarFault('PROPOSAL_UNVALIDATED');
  const validUntil = first
    ? Math.max(...feasible.map(({ candidate }) => Date.parse(candidate.valid_until)))
    : Date.parse(snapshot.scanned_at) + ttl;
  return {
    origin,
    destination: first?.candidate.place ?? origin,
    available_min: window.available_min,
    window: {
      fixed: snapshot.fixed,
      limited_by: window.limited_by,
      manual_min: snapshot.manual_min,
      remaining_min: first?.candidate.remaining_min ?? null,
    },
    valid_until: new Date(validUntil).toISOString(),
    ...(first?.candidate.markers ? { markers: first.candidate.markers } : {}),
    candidates: feasible.map(({ candidate }) => candidate),
    excluded,
    outcome:
      outcome.kind === 'empty'
        ? outcome
        : {
            kind: 'recommendations',
            binding: outcome.binding,
            best: { ...(first ?? { pick: outcome.best }).pick, choice: outcome.best.choice },
            alternatives: feasible.slice(1).map(({ pick }, index) => ({
              ...pick,
              choice: outcome.alternatives[index]?.choice ?? pick.choice,
            })),
          },
  };
}

export function recallOutcome(
  snapshot: RecallSnapshot,
  binding: ProposalBinding,
  reasons?: ReadonlyMap<string, Pick['choice']>,
): RadarOutcome {
  const { feasible, excluded } = screenRecall(snapshot, Date.parse(snapshot.scanned_at));
  const picks = feasible.map(({ pick }) => ({
    ...pick,
    choice: reasons?.get(pick.choice.poi_id) ?? pick.choice,
  }));
  const [best, ...alternatives] = picks;
  if (best) return { kind: 'recommendations', binding, best, alternatives };
  if (excluded.some(({ reason }) => reason === 'route_unverified'))
    throw new MapFault('MAP_UNAVAILABLE');
  return { kind: 'empty', binding, reason_code: 'NO_FEASIBLE_OPTION' };
}
