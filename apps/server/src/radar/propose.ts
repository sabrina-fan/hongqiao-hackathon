import type { RadarRequest } from '@nextstop/core';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { readActiveTrip } from '../trip/store.js';
import type { RadarMap } from './amap.js';
import { effectiveFixed, nextFixedStop } from './fixed-stop.js';
import { createRadar } from './store.js';

export async function getRadarContext(runtime: UserRuntime, at: number) {
  return { fixed: nextFixedStop(await readActiveTrip(runtime), at) };
}

export async function proposeRadar({
  request,
  map,
  withRuntime,
  now,
  signal,
  bindTrip,
}: {
  request: RadarRequest;
  map: RadarMap;
  withRuntime: <T>(run: (runtime: UserRuntime) => Promise<T>) => Promise<T>;
  now: () => number;
  signal: AbortSignal;
  bindTrip: (id: string) => void;
}) {
  const startedAt = now();
  const expectedTrip = await withRuntime(async (runtime) => {
    const trip = await readActiveTrip(runtime);
    if (trip) bindTrip(trip.trip_id);
    return trip;
  });
  const fixed = effectiveFixed(
    nextFixedStop(expectedTrip, startedAt),
    request.fixed_mode,
    startedAt,
  );
  const routeBudget = AbortSignal.any([signal, AbortSignal.timeout(6500)]);
  const evidence = await map.walk(request, routeBudget);
  const onward =
    fixed && Date.parse(fixed.starts_at) > startedAt
      ? await map.walkToFixed({ candidate: evidence, fixed }, routeBudget)
      : null;
  return withRuntime((runtime) =>
    createRadar({ runtime, request, evidence, onward, now, startedAt, expectedTrip }),
  );
}
