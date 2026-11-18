import type { RadarRequest } from '@nextstop/core';
import type { RadarModel } from '@nextstop/model-gateway';
import { modelReasons } from './model-proposal.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { readActiveTrip } from '../trip/store.js';
import type { RadarMap } from './amap.js';
import { effectiveFixed, nextFixedStop } from './fixed-stop.js';
import { createRadar } from './store.js';
import { createRecall } from './recall-store.js';
import { recallCandidates } from './recall.js';

export async function getRadarContext(runtime: UserRuntime, at: number) {
  return { fixed: nextFixedStop(await readActiveTrip(runtime), at) };
}

export async function proposeRadar({
  request,
  map,
  withRuntime,
  model,
  now,
}: {
  request: RadarRequest;
  map: RadarMap;
  model?: RadarModel | null;
  withRuntime: <T>(run: (runtime: UserRuntime) => Promise<T>) => Promise<T>;
  now: () => number;
}) {
  const startedAt = now();
  const expectedTrip = await withRuntime(readActiveTrip);
  const fixed = effectiveFixed(
    nextFixedStop(expectedTrip, startedAt),
    request.fixed_mode,
    startedAt,
  );
  const legacyPick = request.poi_id;
  if (!legacyPick) {
    const snapshot = await withRuntime((runtime) =>
      recallCandidates({ runtime, map, request, startedAt, fixed, now }),
    );
    return withRuntime(async (runtime) => {
      const reasons = model ? await modelReasons(runtime, snapshot, model) : undefined;
      return createRecall({ runtime, snapshot, expectedTrip, now, reasons });
    });
  }
  const routeBudget = AbortSignal.timeout(6500);
  const evidence = await map.walk({ ...request, poi_id: legacyPick }, routeBudget);
  const onward =
    fixed && Date.parse(fixed.starts_at) > startedAt
      ? await map.walkToFixed({ candidate: evidence, fixed }, routeBudget)
      : null;
  return withRuntime((runtime) =>
    createRadar({ runtime, request, evidence, onward, now, startedAt, expectedTrip }),
  );
}
