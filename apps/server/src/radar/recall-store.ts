import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { compile } from '@earendil-works/pi-schema';
import {
  checkProposalBinding,
  sameProposalBinding,
  type ProposalBinding,
  type RejectRadarInput,
  type TripView,
} from '@nextstop/core';
import { MapFault, type RadarMap } from './amap.js';
import { recordRejection } from './feedback-rules.js';
import {
  RadarHistory,
  RadarRecordSchema,
  RadarResults,
  type RadarRecord,
} from '../runtime/documents.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { activeTripDocument, readActiveTrip } from '../trip/store.js';
type ActiveTrip = Awaited<ReturnType<typeof readActiveTrip>>;
import { RadarFault } from './evidence.js';
import { effectiveFixed, nextFixedStop } from './fixed-stop.js';
import type { RecallSnapshot } from './recall-snapshot.js';
import {
  recallEvaluatedAt,
  recallEvidenceExpired,
  recallOutcome,
  recallView,
  recheckRecallRoutes,
  screenRecall,
} from './recall.js';

const recordValidator = compile(RadarRecordSchema);

function withTrip(binding: ProposalBinding, trip: TripView | null): ProposalBinding {
  return trip
    ? { ...binding, trip_id: trip.trip_id, trip_revision: trip.revision }
    : { ...binding, trip_id: null, trip_revision: 0 };
}

function checkFixed(snapshot: RecallSnapshot, trip: ActiveTrip, at: number) {
  try {
    const fixed = effectiveFixed(nextFixedStop(trip, at), snapshot.fixed_mode, at);
    if (
      fixed?.arrangement_id !== snapshot.fixed?.arrangement_id ||
      fixed?.starts_at !== snapshot.fixed?.starts_at ||
      fixed?.address !== snapshot.fixed?.address
    )
      throw new RadarFault('PROPOSAL_STALE');
  } catch (error) {
    if (error instanceof RadarFault) throw new RadarFault('PROPOSAL_STALE');
    throw error;
  }
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
  if (current.at < recallEvaluatedAt(snapshot) || current.at >= Date.parse(view.valid_until))
    throw new RadarFault('PROPOSAL_STALE');
  if (view.outcome.kind === 'recommendations') {
    checkFixed(snapshot, current.trip, current.at);
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

type FeedbackChange =
  | { kind: 'reject'; input: RejectRadarInput }
  | { kind: 'recheck'; binding: ProposalBinding };

async function updateRecall({
  runtime,
  sessionId,
  change,
  map,
  now,
}: {
  runtime: UserRuntime;
  sessionId: string;
  change: FeedbackChange;
  map: RadarMap;
  now: () => number;
}) {
  const conversationId = runtime.conversation.id;
  const binding = change.kind === 'reject' ? change.input.binding : change.binding;
  const current = await runtime.harness.snapshot(
    RadarResults,
    conversationId,
    sessionId,
    BACKGROUND_CONTEXT,
  );
  if (!current?.outcome || !current.recall) throw new RadarFault('NOT_FOUND');
  const view = checkedRecall(current, sessionId);
  const trip = await readActiveTrip(runtime);
  const at = now();
  let { snapshot } = current.recall;
  if (
    !sameProposalBinding(binding, view.outcome.binding) ||
    !sameProposalBinding(binding, withTrip(binding, trip)) ||
    at < recallEvaluatedAt(snapshot)
  ) {
    throw new RadarFault('PROPOSAL_STALE');
  }
  checkFixed(snapshot, trip, at);

  let rejections = snapshot.rejections ?? [];
  if (change.kind === 'reject') {
    const { input } = change;
    const entry = snapshot.verified.find(
      ({ outbound }) => outbound.destination.id === input.poi_id,
    );
    if (!entry || !view.candidates?.some(({ place }) => place.id === input.poi_id))
      throw new RadarFault('NOT_FOUND');
    rejections = [...rejections, recordRejection(input, entry)];
  }

  const refreshed =
    change.kind === 'recheck' ||
    recallEvidenceExpired(snapshot, at) ||
    (change.kind === 'reject' && change.input.reason === 'less_walking');
  if (refreshed) snapshot = await recheckRecallRoutes(snapshot, map, now);
  const nextBinding = {
    ...binding,
    proposal_id: `proposal-${randomUUID()}`,
    proposal_revision: binding.proposal_revision + 1,
    eta_revision: binding.eta_revision + Number(refreshed),
  };
  return runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(RadarResults, conversationId, sessionId, sessionId);
    if (!record.outcome || !sameProposalBinding(record.outcome.binding, binding))
      throw new RadarFault('PROPOSAL_STALE');
    const { trip: active } = await activeTripDocument(tx, conversationId);
    const evaluated = now();
    if (!sameProposalBinding(binding, withTrip(binding, active)))
      throw new RadarFault('PROPOSAL_STALE');
    checkFixed(snapshot, active, evaluated);
    if (recallEvidenceExpired(snapshot, evaluated)) throw new RadarFault('PROPOSAL_STALE');
    const applying = { ...snapshot, rejections, evaluated_at: new Date(evaluated).toISOString() };
    const recall = { snapshot: applying, binding: nextBinding };
    const outcome = recallOutcome(applying, nextBinding);
    const next = checkedRecall({ recall, outcome, validated: nextBinding }, sessionId, {
      trip: active,
      at: evaluated,
    });
    record.recall = recall;
    record.outcome = outcome;
    record.validated = nextBinding;
    return next;
  }, BACKGROUND_CONTEXT);
}

type RecallUpdate = Omit<Parameters<typeof updateRecall>[0], 'change'>;
export const rejectRecall = (options: RecallUpdate & { input: RejectRadarInput }) =>
  updateRecall({ ...options, change: { kind: 'reject', input: options.input } });
export const recheckRecall = (options: RecallUpdate & { binding: ProposalBinding }) =>
  updateRecall({ ...options, change: { kind: 'recheck', binding: options.binding } });
export async function clearRecallFeedback({ runtime, sessionId, now }: Omit<RecallUpdate, 'map'>) {
  const conversationId = runtime.conversation.id;
  const prior = await runtime.harness.snapshot(
    RadarResults,
    conversationId,
    sessionId,
    BACKGROUND_CONTEXT,
  );
  if (!prior?.recall?.snapshot.rejections?.length) return null;
  const view = checkedRecall(prior, sessionId);
  const { snapshot } = prior.recall;
  const binding = view.outcome.binding;
  const resetBinding = {
    ...binding,
    proposal_id: `proposal-${randomUUID()}`,
    proposal_revision: binding.proposal_revision + 1,
  };
  return runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(RadarResults, conversationId, sessionId, sessionId);
    if (!record.outcome || !sameProposalBinding(record.outcome.binding, binding))
      throw new RadarFault('PROPOSAL_STALE');
    const { trip } = await activeTripDocument(tx, conversationId);
    const at = now();
    try {
      if (recallEvidenceExpired(snapshot, at) || at < recallEvaluatedAt(snapshot))
        throw new RadarFault('PROPOSAL_STALE');
      checkFixed(snapshot, trip, at);
      const reset = { ...snapshot, rejections: [], evaluated_at: new Date(at).toISOString() };
      const recall = { binding: resetBinding, snapshot: reset };
      const outcome = recallOutcome(reset, resetBinding);
      const updated = checkedRecall({ recall, outcome, validated: resetBinding }, sessionId, {
        trip,
        at,
      });
      record.recall = recall;
      record.outcome = outcome;
      record.validated = resetBinding;
      return updated;
    } catch (error) {
      if (
        !(error instanceof MapFault) &&
        !(error instanceof RadarFault && error.code === 'PROPOSAL_STALE')
      )
        throw error;
      // Clearing feedback must succeed even if its previous result cannot be revalidated.
      delete record.recall;
      record.outcome = null;
      record.validated = null;
      const history = await tx.doc(RadarHistory, conversationId, 'latest', 'latest');
      if (history.latest === sessionId) history.latest = null;
      return null;
    }
  }, BACKGROUND_CONTEXT);
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
