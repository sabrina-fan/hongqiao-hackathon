import type { RadarRequest } from '@nextstop/core';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { readActiveTrip } from '../trip/store.js';
import type { RadarMap } from './amap.js';
import { fixedContext, fixedForSearch } from './fixed-stop.js';
import { createRadar } from './store.js';

export async function getRadarContext(runtime: UserRuntime, at: number) {
  return fixedContext(await readActiveTrip(runtime), at);
}

export async function proposeRadar({
  request,
  map,
  withRuntime,
  now,
}: {
  request: RadarRequest;
  map: RadarMap;
  withRuntime: <T>(run: (runtime: UserRuntime) => Promise<T>) => Promise<T>;
  now: () => number;
}) {
  const startedAt = now();
  const expectedTrip = await withRuntime(readActiveTrip);
  const fixed = fixedForSearch(expectedTrip, request.fixed_mode, startedAt);
  const routeBudget = AbortSignal.timeout(6500);
  const evidence = await map.walk(request, routeBudget);
  const onward = fixed ? await map.walkToFixed({ candidate: evidence, fixed }, routeBudget) : null;
  return withRuntime((runtime) =>
    createRadar({ runtime, request, evidence, onward, now, startedAt, expectedTrip }),
  );
}
