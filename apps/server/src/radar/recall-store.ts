import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { compile } from '@earendil-works/pi-schema';
import { checkProposalBinding, type ProposalBinding, type TripView } from '@nextstop/core';
import {
  RadarHistory,
  RadarRecordSchema,
  RadarResults,
  type RadarRecord,
} from '../runtime/documents.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { activeTripDocument, type readActiveTrip } from '../trip/store.js';
type ActiveTrip = Awaited<ReturnType<typeof readActiveTrip>>;
import { RadarFault } from './evidence.js';
import { fixedForSearch } from './fixed-stop.js';
import type { RecallSnapshot } from './recall-snapshot.js';
import { recallOutcome, recallView, screenRecall } from './recall.js';

const recordValidator = compile(RadarRecordSchema);

function withTrip(binding: ProposalBinding, trip: TripView | null): ProposalBinding {
  return trip
    ? { ...binding, trip_id: trip.trip_id, trip_revision: trip.revision }
    : { ...binding, trip_id: null, trip_revision: 0 };
}

export function checkedRecall(
  record: RadarRecord,
  sessionId: string,
  current?: { trip: ActiveTrip; at: number },
) {
  if (
    !recordValidator.check(record) ||
    !record.recall ||
    record.session ||
    !record.outcome ||
    record.recall.binding.session_id !== sessionId
  )
    throw new RadarFault('PROPOSAL_UNVALIDATED');
  const { binding, snapshot } = record.recall;
  const verdict = checkProposalBinding({
    outcome: record.outcome,
    validated: record.validated,
    current: current ? withTrip(binding, current.trip) : binding,
  });
  if (verdict === 'PROPOSAL_STALE' || verdict === 'PROPOSAL_UNVALIDATED')
    throw new RadarFault(verdict);
  const view = recallView(snapshot, record.outcome);
  if (!current) return view;
  if (current.at < Date.parse(snapshot.scanned_at) || current.at >= Date.parse(view.valid_until))
    throw new RadarFault('PROPOSAL_STALE');
  let fixed: ReturnType<typeof fixedForSearch>;
  try {
    fixed = fixedForSearch(current.trip, snapshot.fixed_mode, current.at);
  } catch (error) {
    if (error instanceof RadarFault) throw new RadarFault('PROPOSAL_STALE');
    throw error;
  }
  if (
    fixed?.arrangement_id !== snapshot.fixed?.arrangement_id ||
    fixed?.starts_at !== snapshot.fixed?.starts_at
  )
    throw new RadarFault('PROPOSAL_STALE');
  if (view.outcome.kind === 'recommendations') {
    const { eligible } = screenRecall(snapshot, current.at);
    if (
      !view.candidates?.some(({ place }) =>
        eligible.some(({ candidate }) => candidate.place.id === place.id),
      )
    )
      throw new RadarFault('PROPOSAL_STALE');
  }
  return view;
}

export async function createRecall({
  runtime,
  snapshot,
  expectedTrip,
  now,
  reasons,
}: {
  runtime: UserRuntime;
  snapshot: RecallSnapshot;
  expectedTrip: TripView | null;
  now: () => number;
  reasons?: Parameters<typeof recallOutcome>[2];
}) {
  const sessionId = `radar-${randomUUID()}`;
  const conversationId = runtime.conversation.id;
  const binding = withTrip(
    {
      session_id: sessionId,
      proposal_id: `proposal-${randomUUID()}`,
      proposal_revision: 1,
      pool_revision: 1,
      eta_revision: 1,
      trip_id: null,
      trip_revision: 0,
    },
    expectedTrip,
  );
  const recall = { binding, snapshot };
  const outcome = recallOutcome(snapshot, binding, reasons);
  return runtime.conversation.commit(async (tx) => {
    const { trip } = await activeTripDocument(tx, conversationId);
    const entry = { recall, outcome, validated: binding };
    const view = checkedRecall(entry, sessionId, { trip, at: now() });
    const record = await tx.doc(RadarResults, conversationId, sessionId, sessionId);
    const history = await tx.doc(RadarHistory, conversationId, 'latest', 'latest');
    record.recall = recall;
    record.outcome = outcome;
    record.validated = binding;
    history.latest = sessionId;
    return view;
  }, BACKGROUND_CONTEXT);
}
