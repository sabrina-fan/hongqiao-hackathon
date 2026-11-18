import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { compile } from '@earendil-works/pi-schema';
import {
  acceptRadarValidator,
  checkProposalBinding,
  fitsTimeWindow,
  IdentifierSchema,
  radarRequestValidator,
  sameProposalBinding,
} from '@nextstop/core';
import type {
  AcceptRadarInput,
  AcceptReceipt,
  ProposalBinding,
  RadarRequest,
  RadarView,
  TripView,
} from '@nextstop/core';
import { randomUUID } from 'node:crypto';
import {
  AcceptReceipts,
  RadarRecordSchema,
  RadarResults,
  type RadarRecord,
  type RadarSessionSnapshot,
} from '../runtime/documents.js';
import { activeTripDocument, getTrip } from '../trip/store.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { RadarFault, WalkingEvidenceSchema, type WalkingEvidence } from './evidence.js';

const walkingEvidence = compile(WalkingEvidenceSchema);
const recordValidator = compile(RadarRecordSchema);
const identifier = compile(IdentifierSchema);
const MAX_WALK_M = 5000;
const STAY_MIN = 20;
const BUFFER_MIN = 10;
const MINUTE = 60_000;
const ETA_TTL = 5 * MINUTE;

function fits(session: RadarSessionSnapshot, at: number) {
  return (
    session.distance_m <= MAX_WALK_M &&
    fitsTimeWindow({
      available_min: session.available_min - Math.max(0, at - session.created_ms) / MINUTE,
      travel_to_min: session.travel_min,
      stay_min: STAY_MIN,
      travel_after_min: 0,
      buffer_min: BUFFER_MIN,
    })
  );
}
function bindingFor(session: RadarSessionSnapshot, trip: TripView | null): ProposalBinding {
  const base = {
    session_id: session.session_id,
    proposal_id: session.proposal_id,
    proposal_revision: session.proposal_revision,
    pool_revision: session.pool_revision,
    eta_revision: session.eta_revision,
  };
  return trip
    ? { ...base, trip_id: trip.trip_id, trip_revision: trip.revision }
    : { ...base, trip_id: null, trip_revision: 0 };
}
function viewOf(
  session: RadarSessionSnapshot,
  binding: ProposalBinding,
  feasible: boolean,
): RadarView {
  const etaExpires = Date.parse(session.valid_until);
  const latestStart =
    session.created_ms +
    (session.available_min - session.travel_min - STAY_MIN - BUFFER_MIN) * MINUTE;
  return {
    origin: { ...session.origin },
    destination: { ...session.destination },
    available_min: session.available_min,
    valid_until: feasible
      ? new Date(Math.min(etaExpires, latestStart)).toISOString()
      : session.valid_until,
    outcome: feasible
      ? {
          kind: 'recommendations',
          binding,
          alternatives: [],
          best: {
            choice: {
              poi_id: session.poi_id,
              reason_code: 'basic_fit',
              reason_text: '步行可达，停留和缓冲都在可用时间内。',
            },
            travel_to_min: session.travel_min,
            travel_to_next_min: null,
            stay_min_estimate: STAY_MIN,
            buffer_min: BUFFER_MIN,
            evidence: { provider: 'amap', fetched_at: session.fetched_at, status: 'estimated' },
          },
        }
      : { kind: 'empty', binding, reason_code: 'NO_FEASIBLE_OPTION' },
  };
}

// Display and acceptance use the same gate. Only the application's snapshot supplies shown facts.
function checkedView(
  record: RadarRecord | undefined,
  sessionId: string,
  trip: TripView | null,
  at: number,
): RadarView {
  if (!record?.session || !record.outcome) throw new RadarFault('NOT_FOUND');
  if (!recordValidator.check(record)) throw new RadarFault('PROPOSAL_UNVALIDATED');
  const { session, outcome, validated } = record;
  if (
    session.session_id !== sessionId ||
    outcome.binding.session_id !== sessionId ||
    session.destination.id !== session.poi_id ||
    session.origin.id !== session.origin_id
  )
    throw new RadarFault('PROPOSAL_UNVALIDATED');
  const current = bindingFor(session, trip);
  const verdict = checkProposalBinding({ outcome, validated, current });
  if (verdict === 'PROPOSAL_STALE' || verdict === 'PROPOSAL_UNVALIDATED')
    throw new RadarFault(verdict);
  if (
    at < session.created_ms ||
    at < Date.parse(session.fetched_at) ||
    at >= Date.parse(session.valid_until)
  )
    throw new RadarFault('PROPOSAL_STALE');
  const feasible = fits(session, at);
  if (outcome.kind === 'recommendations') {
    if (outcome.best.choice.poi_id !== session.poi_id || outcome.alternatives.length)
      throw new RadarFault('PROPOSAL_UNVALIDATED');
    if (!feasible) throw new RadarFault('PROPOSAL_STALE');
  } else if (feasible) throw new RadarFault('PROPOSAL_UNVALIDATED');
  return viewOf(session, current, feasible);
}

export async function createRadar({
  runtime,
  request,
  evidence,
  now,
  startedAt,
}: {
  runtime: UserRuntime;
  request: RadarRequest;
  evidence: WalkingEvidence;
  now: () => number;
  startedAt?: number;
}): Promise<RadarView> {
  if (!radarRequestValidator.check(request)) throw new Error('Invalid radar request');
  if (!walkingEvidence.check(evidence)) throw new Error('Invalid walking evidence');
  if (evidence.origin.id !== request.origin_id || evidence.destination.id !== request.poi_id)
    throw new Error('Walking evidence does not match the requested candidate');
  const conversationId = runtime.conversation.id;
  const sessionId = `radar-${randomUUID()}`;
  return runtime.conversation.commit(async (tx) => {
    const trip = await activeTripDocument(tx, conversationId);
    const record = await tx.doc(RadarResults, conversationId, sessionId, sessionId);
    const at = now();
    const fetched = Date.parse(evidence.fetched_at);
    if (!Number.isFinite(fetched) || fetched > at || (startedAt !== undefined && startedAt > at))
      throw new Error('Invalid walking evidence');
    if (at - fetched >= ETA_TTL) throw new RadarFault('PROPOSAL_STALE');
    const session: RadarSessionSnapshot = {
      ...request,
      ...evidence,
      session_id: sessionId,
      proposal_id: `proposal-${randomUUID()}`,
      created_ms: startedAt ?? at,
      valid_until: new Date(fetched + ETA_TTL).toISOString(),
      proposal_revision: 1,
      pool_revision: 1,
      eta_revision: 1,
    };
    const binding = bindingFor(session, trip.trip);
    const view = viewOf(session, binding, fits(session, at));
    record.session = session;
    record.outcome = view.outcome;
    record.validated = binding;
    return view;
  }, BACKGROUND_CONTEXT);
}
export async function getRadar({
  runtime,
  sessionId,
  now,
}: {
  runtime: UserRuntime;
  sessionId: string;
  now: () => number;
}): Promise<RadarView> {
  if (!identifier.check(sessionId)) throw new RadarFault('NOT_FOUND');
  const record = await runtime.harness.snapshot(
    RadarResults,
    runtime.conversation.id,
    sessionId,
    BACKGROUND_CONTEXT,
  );
  return checkedView(record, sessionId, await getTrip({ runtime }), now());
}
function fingerprint(sessionId: string, { binding, poi_id }: AcceptRadarInput) {
  return JSON.stringify([
    sessionId,
    binding.session_id,
    binding.proposal_id,
    binding.proposal_revision,
    binding.pool_revision,
    binding.eta_revision,
    binding.trip_id,
    binding.trip_revision,
    poi_id,
  ]);
}
export async function acceptRadar({
  runtime,
  sessionId,
  input,
  key,
  now,
}: {
  runtime: UserRuntime;
  sessionId: string;
  input: AcceptRadarInput;
  key: string;
  now: () => number;
}): Promise<AcceptReceipt> {
  if (!identifier.check(sessionId)) throw new RadarFault('NOT_FOUND');
  if (!acceptRadarValidator.check(input) || !identifier.check(key))
    throw new Error('Invalid confirmation');
  const conversationId = runtime.conversation.id;
  const identity = fingerprint(sessionId, input);
  return runtime.conversation.commit(async (tx) => {
    const idem = await tx.doc(AcceptReceipts, conversationId, key, key);
    if (idem.entry) {
      if (idem.entry.fingerprint !== identity) throw new RadarFault('IDEMPOTENCY_CONFLICT');
      const { trip_id, trip_revision, stop } = idem.entry.receipt;
      return { trip_id, trip_revision, stop: { ...stop } };
    }
    if (input.binding.session_id !== sessionId) throw new RadarFault('PROPOSAL_UNVALIDATED');
    const record = await tx.doc(RadarResults, conversationId, sessionId, sessionId);
    if (!record.outcome) throw new RadarFault('NOT_FOUND');
    if (!sameProposalBinding(input.binding, record.outcome.binding))
      throw new RadarFault('PROPOSAL_STALE');
    const tripDoc = await activeTripDocument(tx, conversationId);
    const view = checkedView(record, sessionId, tripDoc.trip, now());
    if (view.outcome.kind === 'empty') throw new RadarFault('NO_FEASIBLE_OPTION');
    if (view.destination.id !== input.poi_id) throw new RadarFault('NOT_FOUND');
    const stop = {
      stop_id: `stop-${randomUUID()}`,
      poi_id: input.poi_id,
      name: view.destination.name,
    };
    const prior = tripDoc.trip;
    const trip = {
      ...(prior?.day ? { day: { ...prior.day } } : {}),
      ...(prior?.arrangements
        ? { arrangements: prior.arrangements.map((item) => ({ ...item })) }
        : {}),
      trip_id: prior?.trip_id ?? `trip-${randomUUID()}`,
      revision: (prior?.revision ?? 0) + 1,
      stops: [...(prior?.stops.map((item) => ({ ...item })) ?? []), stop],
    };
    const receipt = { trip_id: trip.trip_id, trip_revision: trip.revision, stop };
    tripDoc.trip = trip;
    idem.entry = { fingerprint: identity, receipt };
    return receipt;
  }, BACKGROUND_CONTEXT);
}
