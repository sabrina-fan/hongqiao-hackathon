import { undoRadarValidator } from '@nextstop/core';
import type { IncomingMessage } from 'node:http';
import { readJson } from '../http.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { getRadarAcceptance, undoRadarAcceptance } from './acceptance.js';

export function radarAcceptanceRoute(request: IncomingMessage, path: string) {
  const match = /^\/api\/v1\/radar\/sessions\/([A-Za-z0-9_-]{1,100})\/acceptance(\/undo)?$/.exec(
    path,
  );
  const sessionId = match?.[1];
  if (!sessionId) return null;
  if (request.method === 'GET' && !match?.[2])
    return (runtime: UserRuntime) => getRadarAcceptance(runtime, sessionId);
  if (request.method === 'POST' && match?.[2])
    return async (runtime: UserRuntime) => {
      const { stop_id: stopId } = await readJson(request, undoRadarValidator.check);
      return undoRadarAcceptance({ runtime, sessionId, stopId });
    };
  return null;
}
