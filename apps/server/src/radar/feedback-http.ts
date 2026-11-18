import type { RadarFeedbackClear } from '@nextstop/core';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { clearRecallFeedback, readRecallFeedback } from './recall-store.js';

export function radarFeedbackRoute(method: string | undefined, path: string, now: () => number) {
  if (method !== 'GET' && method !== 'DELETE') return null;
  const sessionId = /^\/api\/v1\/radar\/sessions\/([A-Za-z0-9_-]{1,100})\/feedback$/.exec(
    path,
  )?.[1];
  if (!sessionId) return null;
  return async (runtime: UserRuntime) => {
    // Inspect and clear under the same guest writer so a null reset has an unambiguous meaning.
    const feedback = await readRecallFeedback(runtime, sessionId);
    if (!feedback) return { kind: 'none' } satisfies RadarFeedbackClear;
    if (method === 'GET') return { kind: 'active', feedback };
    const reset = await clearRecallFeedback({ runtime, sessionId, now });
    return { kind: reset ? 'restored' : 'invalidated' } satisfies RadarFeedbackClear;
  };
}
