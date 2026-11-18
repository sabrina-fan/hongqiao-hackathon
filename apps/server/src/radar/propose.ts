import type { RadarRequest } from '@nextstop/core';
import type { RadarModel } from '@nextstop/model-gateway';
import { modelReasons } from './model-proposal.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { readActiveTrip } from '../trip/store.js';
import { readWishlist } from '../wishlist/store.js';
import type { RadarMap } from './amap.js';
import { fixedContext, fixedForSearch } from './fixed-stop.js';
import { createRadar } from './store.js';
import { createRecall } from './recall-store.js';
import { recallCandidates } from './recall.js';

export async function getRadarContext(runtime: UserRuntime, at: number) {
  return fixedContext(await readActiveTrip(runtime), at);
}

export async function proposeRadar({
  request,
  map,
  withRuntime,
  model,
  now,
  signal,
  bindTrip,
}: {
  request: RadarRequest;
  map: RadarMap;
  model?: RadarModel | null;
  withRuntime: <T>(run: (runtime: UserRuntime) => Promise<T>) => Promise<T>;
  now: () => number;
  signal: AbortSignal;
  bindTrip: (id: string) => void;
}) {
  const startedAt = now();
  const legacyPick = request.poi_id;
  const { expectedTrip, saved } = await withRuntime(async (runtime) => {
    const trip = await readActiveTrip(runtime);
    if (trip) bindTrip(trip.trip_id);
    const saved = legacyPick ? [] : (await readWishlist(runtime, { visit: 'unvisited' })).places;
    return { expectedTrip: trip, saved };
  });
  const fixed = fixedForSearch(expectedTrip, request.fixed_mode, startedAt);
  if (!legacyPick) {
    const snapshot = await recallCandidates({
      saved,
      map,
      request,
      startedAt,
      fixed,
      now,
      ownerSignal: signal,
    });
    return withRuntime(async (runtime) => {
      signal.throwIfAborted();
      const reasons = model ? await modelReasons(runtime, snapshot, model) : undefined;
      return createRecall({ runtime, snapshot, expectedTrip, now, reasons });
    });
  }
  const routeBudget = AbortSignal.any([signal, AbortSignal.timeout(6500)]);
  const evidence = await map.walk({ ...request, poi_id: legacyPick }, routeBudget);
  const onward = fixed ? await map.walkToFixed({ candidate: evidence, fixed }, routeBudget) : null;
  return withRuntime((runtime) =>
    createRadar({ runtime, request, evidence, onward, now, startedAt, expectedTrip }),
  );
}
