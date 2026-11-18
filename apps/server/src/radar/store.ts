import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Tx } from '@earendil-works/pi-durable';
import { compile } from '@earendil-works/pi-schema';
import {
  acceptRadarValidator,
  checkProposalBinding,
  fitsTimeWindow,
  IdentifierSchema,
  liveOriginId,
  radarWindow,
  radarRequestValidator,
  sameProposalBinding,
} from '@nextstop/core';
import type {
  AcceptRadarInput,
  AcceptReceipt,
  ProposalBinding,
  FixedStop,
  RadarRequest,
  RadarView,
  TripView,
} from '@nextstop/core';
import { randomUUID } from 'node:crypto';
import {
  AcceptReceipts,
  RadarRecordSchema,
  RadarResults,
  RadarHistory,
  radarHistoryStateValidator,
  type RadarRecord,
  type RadarSessionSnapshot,
} from '../runtime/documents.js';
import { activeTripDocument, readActiveTrip } from '../trip/store.js';
import { fixedForSearch } from './fixed-stop.js';
import { RadarAcceptances } from './acceptance.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { RadarFault, WalkingEvidenceSchema, type WalkingEvidence } from './evidence.js';
import { checkedRecall } from './recall-store.js';
import { openingCovers, screenRecall } from './recall.js';

const walkingEvidence = compile(WalkingEvidenceSchema);
const recordValidator = compile(RadarRecordSchema);
const identifier = compile(IdentifierSchema);
const MAX_WALK_M = 5000;
const BUFFER_MIN = 10;
const MINUTE = 60_000;
const ETA_TTL = 5 * MINUTE;
const HISTORY_KEY = 'latest';

type ActiveTrip = Awaited<ReturnType<typeof readActiveTrip>>;

function timing(session: RadarSessionSnapshot) {
  const fixed = session.constraints?.fixed ?? null;
  const window = radarWindow({
    started_ms: session.created_ms,
    manual_min: session.available_min,
    fixed_ms: fixed ? Date.parse(fixed.starts_at) : null,
  });
  const travelAfter = session.constraints?.onward?.travel_min ?? null;
  const stay = fixed ? 40 : 20;
  // Persisted v1 requests without an explicit mode included a planning buffer.
  const buffer = fixed || !session.constraints?.fixed_mode ? BUFFER_MIN : 0;
  return {
    ...window,
    fixed,
    travelAfter,
    stay,
    buffer,
    total: session.travel_min + stay + (travelAfter ?? 0) + buffer,
  };
}

function fits(session: RadarSessionSnapshot, at: number) {
  const { fixed, deadline_ms, travelAfter, stay, buffer } = timing(session);
  const maxWalk = session.constraints?.preference === 'short_walk' ? 1500 : MAX_WALK_M;
  return (
    (!fixed || travelAfter !== null) &&
    session.facts?.booking?.state !== 'required' &&
    (!session.facts?.opening ||
      openingCovers(session.facts.opening.today, at + session.travel_min * MINUTE, stay)) &&
    session.distance_m <= maxWalk &&
    (session.constraints?.onward?.distance_m ?? 0) <= MAX_WALK_M &&
    fitsTimeWindow({
      available_min: (deadline_ms - at) / MINUTE,
      travel_to_min: session.travel_min,
      stay_min: stay,
      travel_after_min: travelAfter ?? 0,
      buffer_min: buffer,
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
  const { fixed, available_min, limited_by, deadline_ms, total, stay, buffer, travelAfter } =
    timing(session);
  const latestStart = deadline_ms - total * MINUTE;
  const nextMarker = session.constraints?.onward?.markers?.destination;
  return {
    origin: { ...session.origin },
    destination: { ...session.destination },
    available_min,
    window: {
      fixed,
      manual_min: session.available_min,
      limited_by,
      remaining_min: feasible ? available_min - total : null,
    },
    ...(session.facts ? { facts: session.facts } : {}),
    ...(session.markers
      ? { markers: { ...session.markers, ...(nextMarker ? { next: nextMarker } : {}) } }
      : {}),
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
              reason_text: fixed
                ? '步行、停留和缓冲都能在固定安排开始前完成。'
                : '步行和停留都在可用时间内。',
            },
            travel_to_min: session.travel_min,
            travel_to_next_min: travelAfter,
            stay_min_estimate: stay,
            buffer_min: buffer,
            evidence: { provider: 'amap', fetched_at: session.fetched_at, status: 'estimated' },
          },
        }
      : { kind: 'empty', binding, reason_code: 'NO_FEASIBLE_OPTION' },
  };
}

function checkedRecord(record: RadarRecord | undefined, sessionId: string) {
  if (!record?.session || !record.outcome) throw new RadarFault('NOT_FOUND');
  if (!recordValidator.check(record)) throw new RadarFault('PROPOSAL_UNVALIDATED');
  const { session, outcome, validated } = record;
  const { fixed, onward } = session.constraints ?? {};
  if (
    session.session_id !== sessionId ||
    outcome.binding.session_id !== sessionId ||
    session.destination.id !== session.poi_id ||
    session.origin.id !== session.origin_id ||
    (fixed && Date.parse(fixed.starts_at) > session.created_ms && !onward) ||
    (onward &&
      (!fixed ||
        onward.origin.id !== session.poi_id ||
        onward.destination.id !== fixed.arrangement_id ||
        onward.destination.address !== fixed.address ||
        (session.markers &&
          (!onward.markers ||
            onward.markers.origin.longitude !== session.markers.destination.longitude ||
            onward.markers.origin.latitude !== session.markers.destination.latitude)))) ||
    (outcome.kind === 'recommendations' &&
      (outcome.best.choice.poi_id !== session.poi_id || outcome.alternatives.length))
  )
    throw new RadarFault('PROPOSAL_UNVALIDATED');
  return { session, outcome, validated };
}

// Display and acceptance use the same gate. Only the application's snapshot supplies shown facts.
function checkedView(
  record: RadarRecord | undefined,
  sessionId: string,
  trip: ActiveTrip,
  at: number,
): RadarView {
  if (record?.recall) return checkedRecall(record, sessionId, { trip, at });
  const { session, outcome, validated } = checkedRecord(record, sessionId);
  const current = bindingFor(session, trip);
  const verdict = checkProposalBinding({ outcome, validated, current });
  if (verdict === 'PROPOSAL_STALE' || verdict === 'PROPOSAL_UNVALIDATED')
    throw new RadarFault(verdict);
  if (
    at < session.created_ms ||
    at < Date.parse(session.fetched_at) ||
    at < Date.parse(session.constraints?.onward?.fetched_at ?? session.fetched_at) ||
    at >= Date.parse(session.valid_until)
  )
    throw new RadarFault('PROPOSAL_STALE');
  let fixed: FixedStop | null;
  try {
    fixed = fixedForSearch(trip, session.constraints?.fixed_mode, at);
  } catch (error) {
    if (error instanceof RadarFault) throw new RadarFault('PROPOSAL_STALE');
    throw error;
  }
  if (
    fixed?.arrangement_id !== session.constraints?.fixed?.arrangement_id ||
    fixed?.starts_at !== session.constraints?.fixed?.starts_at
  )
    throw new RadarFault('PROPOSAL_STALE');
  const feasible = fits(session, at);
  if (outcome.kind === 'recommendations') {
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
  expectedTrip,
  onward = null,
}: {
  runtime: UserRuntime;
  request: RadarRequest;
  evidence: WalkingEvidence;
  now: () => number;
  startedAt?: number;
  expectedTrip?: TripView | null;
  onward?: WalkingEvidence | null;
}): Promise<RadarView> {
  if (!radarRequestValidator.check(request)) throw new Error('Invalid radar request');
  if (!walkingEvidence.check(evidence) || (onward && !walkingEvidence.check(onward)))
    throw new Error('Invalid walking evidence');
  const origin_id = 'origin_id' in request ? request.origin_id : liveOriginId;
  if (evidence.origin.id !== origin_id || evidence.destination.id !== request.poi_id)
    throw new Error('Walking evidence does not match the requested candidate');
  const conversationId = runtime.conversation.id;
  const sessionId = `radar-${randomUUID()}`;
  return runtime.conversation.commit(async (tx) => {
    const { trip } = await activeTripDocument(tx, conversationId);
    if (
      expectedTrip !== undefined &&
      (expectedTrip?.trip_id !== trip?.trip_id || expectedTrip?.revision !== trip?.revision)
    )
      throw new RadarFault('PROPOSAL_STALE');
    const at = now();
    const created_ms = startedAt ?? at;
    const fixed = fixedForSearch(trip, request.fixed_mode, created_ms);
    const fetched = Date.parse(evidence.fetched_at);
    const onwardFetched = onward ? Date.parse(onward.fetched_at) : fetched;
    if (
      ![fetched, onwardFetched].every((time) => Number.isFinite(time) && time <= at) ||
      created_ms > at
    )
      throw new Error('Invalid walking evidence');
    const expires = Math.min(fetched, onwardFetched) + ETA_TTL;
    if (at >= expires) throw new RadarFault('PROPOSAL_STALE');
    const session: RadarSessionSnapshot = {
      origin_id,
      poi_id: evidence.destination.id,
      available_min: request.available_min,
      ...evidence,
      constraints: {
        fixed,
        onward,
        ...(request.fixed_mode ? { fixed_mode: request.fixed_mode } : {}),
        ...(request.preference ? { preference: request.preference } : {}),
      },
      session_id: sessionId,
      proposal_id: `proposal-${randomUUID()}`,
      created_ms,
      valid_until: new Date(expires).toISOString(),
      proposal_revision: 1,
      pool_revision: 1,
      eta_revision: 1,
    };
    const binding = bindingFor(session, trip);
    const view = viewOf(session, binding, fits(session, at));
    const validated = { session, outcome: view.outcome, validated: binding };
    checkedView(validated, sessionId, trip, at);
    const record = await tx.doc(RadarResults, conversationId, sessionId, sessionId);
    const history = await tx.doc(RadarHistory, conversationId, HISTORY_KEY, HISTORY_KEY);
    record.session = session;
    record.outcome = view.outcome;
    record.validated = binding;
    history.latest = sessionId;
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
  const record = await readResult(runtime, sessionId);
  const trip = await readActiveTrip(runtime);
  try {
    return checkedView(record, sessionId, trip, now());
  } catch (error) {
    if (
      !(error instanceof RadarFault) ||
      error.code !== 'PROPOSAL_STALE' ||
      !record?.recall?.snapshot.rejections?.length
    )
      throw error;
    return { ...checkedRecall(record, sessionId), evidence_status: 'stale' };
  }
}

function readResult(runtime: UserRuntime, sessionId: string) {
  return runtime.harness.snapshot(
    RadarResults,
    runtime.conversation.id,
    sessionId,
    BACKGROUND_CONTEXT,
  );
}

export async function prepareRadarRetirement(runtime: UserRuntime, tripId: string) {
  const scope = runtime.conversation.id;
  const sessionIds = new Set<string>();
  for (const id of await runtime.familyKeys(RadarResults.definition.kind)) {
    const record = await readResult(runtime, id);
    if (record?.outcome?.binding.trip_id === tripId) sessionIds.add(id);
  }
  for (const id of await runtime.familyKeys(RadarAcceptances.definition.kind)) {
    const record = await runtime.harness.snapshot(RadarAcceptances, scope, id, BACKGROUND_CONTEXT);
    if (record?.acceptance?.receipt.trip_id === tripId) sessionIds.add(id);
  }
  const receiptKeys: string[] = [];
  for (const key of await runtime.familyKeys(AcceptReceipts.definition.kind)) {
    const record = await runtime.harness.snapshot(AcceptReceipts, scope, key, BACKGROUND_CONTEXT);
    if (record?.entry?.receipt.trip_id === tripId) receiptKeys.push(key);
  }
  return async (tx: Tx) => {
    for (const id of sessionIds) {
      await tx.retireDoc(RadarResults, scope, id);
      await tx.retireDoc(RadarAcceptances, scope, id);
    }
    for (const key of receiptKeys) await tx.retireDoc(AcceptReceipts, scope, key);
    const history = await tx.doc(RadarHistory, scope, HISTORY_KEY, HISTORY_KEY);
    if (history.latest && sessionIds.has(history.latest)) history.latest = null;
  };
}

export async function getRadarHistory(runtime: UserRuntime, at: number) {
  const entry = await runtime.harness.snapshot(
    RadarHistory,
    runtime.conversation.id,
    HISTORY_KEY,
    BACKGROUND_CONTEXT,
  );
  if (!entry) return null;
  if (!radarHistoryStateValidator.check(entry)) throw new Error('Invalid radar history');
  const sessionId = entry.latest;
  if (!sessionId) return null;
  const record = await readResult(runtime, sessionId);
  const trip = await readActiveTrip(runtime);
  try {
    return { status: 'saved', view: checkedView(record, sessionId, trip, at) } satisfies {
      status: 'saved';
      view: RadarView;
    };
  } catch (error) {
    if (!(error instanceof RadarFault) || error.code !== 'PROPOSAL_STALE') throw error;
    if (record?.recall) return { status: 'stale' as const, view: checkedRecall(record, sessionId) };
    const { session, outcome, validated } = checkedRecord(record, sessionId);
    const original = bindingFor(
      session,
      outcome.binding.trip_id === null
        ? null
        : {
            trip_id: outcome.binding.trip_id,
            revision: outcome.binding.trip_revision,
            stops: [],
          },
    );
    const verdict = checkProposalBinding({ outcome, validated, current: original });
    if (verdict === 'PROPOSAL_UNVALIDATED' || verdict === 'PROPOSAL_STALE')
      throw new RadarFault(verdict);
    return {
      status: 'stale',
      view: viewOf(session, original, outcome.kind === 'recommendations'),
    } satisfies { status: 'stale'; view: RadarView };
  }
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
    const at = now();
    const view = checkedView(record, sessionId, tripDoc.trip, at);
    if (view.outcome.kind === 'empty') throw new RadarFault('NO_FEASIBLE_OPTION');
    const selected = view.candidates
      ? view.candidates.find(({ place }) => place.id === input.poi_id)
      : view.destination.id === input.poi_id
        ? { place: view.destination, markers: view.markers }
        : undefined;
    if (!selected) throw new RadarFault('NOT_FOUND');
    const { place: destination, markers } = selected;
    if (
      record.recall &&
      !screenRecall(record.recall.snapshot, at).eligible.some(
        ({ candidate }) => candidate.place.id === input.poi_id,
      )
    )
      throw new RadarFault('PROPOSAL_STALE');
    const stop = {
      stop_id: `stop-${randomUUID()}`,
      poi_id: input.poi_id,
      name: destination.name,
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
    const confirmation = await tx.doc(RadarAcceptances, conversationId, sessionId, sessionId);
    tripDoc.trip = trip;
    idem.entry = { fingerprint: identity, receipt };
    confirmation.acceptance = {
      status: 'added',
      receipt,
      destination,
      ...(markers ? { point: { ...markers.destination } } : {}),
    };
    return receipt;
  }, BACKGROUND_CONTEXT);
}
