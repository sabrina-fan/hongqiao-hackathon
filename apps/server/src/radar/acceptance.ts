import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { radarAcceptanceValidator, type RadarAcceptance } from '@nextstop/core';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { tripInTransaction } from '../trip/store.js';
import { RadarFault } from './evidence.js';

export const RadarAcceptances = defineDocFamily<{ acceptance: RadarAcceptance | null }, string>({
  kind: 'nextstop.radar_acceptance',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ acceptance: null }),
  checkpointWhen: () => true,
});

function checkedAcceptance(value: unknown) {
  if (value == null) throw new RadarFault('NOT_FOUND');
  if (!radarAcceptanceValidator.check(value)) throw new Error('Invalid stored radar acceptance');
  return value;
}

export async function getRadarAcceptance(runtime: UserRuntime, sessionId: string) {
  const record = await runtime.harness.snapshot(
    RadarAcceptances,
    runtime.conversation.id,
    sessionId,
    BACKGROUND_CONTEXT,
  );
  return checkedAcceptance(record?.acceptance);
}

export async function undoRadarAcceptance({
  runtime,
  sessionId,
  stopId,
}: {
  runtime: UserRuntime;
  sessionId: string;
  stopId: RadarAcceptance['receipt']['stop']['stop_id'];
}) {
  const conversationId = runtime.conversation.id;
  await runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(RadarAcceptances, conversationId, sessionId, sessionId);
    const acceptance = checkedAcceptance(record.acceptance);
    const { receipt } = acceptance;
    if (receipt.stop.stop_id !== stopId) throw new RadarFault('ACCEPTANCE_MISMATCH');
    if (acceptance.status === 'undone') return;

    // Rebase the removal on the current contents of the receipt's trip, even if another trip is active.
    const trip = await tripInTransaction(tx, conversationId, receipt.trip_id);
    const index = trip.stops.findIndex((stop) => stop.stop_id === stopId);
    if (index !== -1) {
      trip.stops.splice(index, 1);
      trip.revision += 1;
    }
    acceptance.status = 'undone';
  }, BACKGROUND_CONTEXT);
  return getRadarAcceptance(runtime, sessionId);
}
