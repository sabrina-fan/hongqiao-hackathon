import { arrangementWriteValidator, tripDayValidator, tripEditValidator } from '@nextstop/core';
import type { IncomingMessage } from 'node:http';
import { readJson } from '../http.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { createTrip, editTrip, getTripDetail, listTrips, saveArrangement } from './store.js';

type RunForGuest = <T>(run: (runtime: UserRuntime) => Promise<T>) => Promise<T>;

export function tripRoute(method: string | undefined, path: string) {
  if (path === '/api/v1/trips') {
    if (method === 'GET') return { status: 200, handle: (run: RunForGuest) => run(listTrips) };
    if (method === 'POST')
      return {
        status: 201,
        async handle(run: RunForGuest, request: IncomingMessage) {
          const day = await readJson(request, tripDayValidator.check);
          return run((runtime) => createTrip(runtime, day));
        },
      };
  }
  const match =
    /^\/api\/v1\/trips\/([A-Za-z0-9_-]{1,100})(\/arrangements(?:\/([A-Za-z0-9_-]{1,100}))?)?$/.exec(
      path,
    );
  const id = match?.[1];
  if (!id) return null;
  if (match[2]) {
    if (method !== 'POST') return null;
    const arrangementId = match[3];
    return {
      status: 200,
      async handle(run: RunForGuest, request: IncomingMessage) {
        const input = await readJson(request, arrangementWriteValidator.check);
        return run((runtime) => saveArrangement({ runtime, id, ...input, arrangementId }));
      },
    };
  }
  if (method === 'GET')
    return {
      status: 200,
      handle: (run: RunForGuest) => run((runtime) => getTripDetail(runtime, id)),
    };
  if (method === 'POST')
    return {
      status: 200,
      async handle(run: RunForGuest, request: IncomingMessage) {
        const { revision, day } = await readJson(request, tripEditValidator.check);
        return run((runtime) => editTrip(runtime, id, revision, day));
      },
    };
  return null;
}
