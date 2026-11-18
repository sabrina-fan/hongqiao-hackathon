import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { compile, nullable, obj, type Static } from '@earendil-works/pi-schema';
import {
  RevisionSchema,
  TripDetailSchema,
  TripDraftSchema,
  type DraftEdit,
  type DraftEntry,
  type DraftVersion,
  type TripDraft,
} from '@nextstop/core';
import { randomUUID } from 'node:crypto';
import { HttpFault } from '../http.js';
import { readWishlist } from '../imports/store.js';
import type { RadarMap } from '../radar/amap.js';
import { Trips } from '../runtime/documents.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { draftCandidates, editDraftEntries, scheduleDraft } from './draft-plan.js';
import { draftWalking } from './draft-walking.js';
import { arrangementWarnings } from './rules.js';
import { findTrip, tripDetail, TripFault } from './store.js';

const DraftState = obj({ draft: nullable(TripDraftSchema) });
const draftState = compile(DraftState);
const Drafts = defineDocFamily<Static<typeof DraftState>, string>({
  kind: 'nextstop.trip_draft',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ draft: null }),
  checkpointWhen: () => true,
});
const ReceiptState = obj({
  receipt: nullable(obj({ revision: RevisionSchema, trip: TripDetailSchema })),
});
const receiptState = compile(ReceiptState);
const DraftReceipts = defineDocFamily<Static<typeof ReceiptState>, string>({
  kind: 'nextstop.trip_draft_receipt',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ receipt: null }),
  checkpointWhen: () => true,
});

export type RunForGuest = <T>(run: (runtime: UserRuntime) => Promise<T>) => Promise<T>;

type DraftContext = {
  id: string;
  run: RunForGuest;
  now: () => number;
  map?: RadarMap | null | undefined;
};

async function readDraft(runtime: UserRuntime, id: string) {
  const stored = await runtime.harness.snapshot(
    Drafts,
    runtime.conversation.id,
    id,
    BACKGROUND_CONTEXT,
  );
  if (!stored) return null;
  if (!draftState.check(stored)) throw new Error('Invalid stored trip draft');
  return stored.draft;
}

function stale(draft: TripDraft, tripRevision: number, now: number) {
  return draft.trip_revision !== tripRevision || draft.expires_at <= now;
}

function sameCandidates(entries: DraftEntry[], candidates: DraftEntry[]) {
  if (entries.length !== candidates.length) return false;
  const byId = new Map(candidates.map((entry) => [entry.poi_id, entry]));
  return entries.every(({ poi_id, name, address }) => {
    const candidate = byId.get(poi_id);
    return candidate?.name === name && candidate.address === address;
  });
}

async function readCandidates(runtime: UserRuntime, trip: Parameters<typeof draftCandidates>[0]) {
  return draftCandidates(trip, (await readWishlist(runtime)).places);
}

function isVersion(draft: TripDraft | null, version: DraftVersion | null) {
  if (!version) return draft === null;
  return draft?.draft_id === version.draft_id && draft.revision === version.revision;
}

export function getDraft({ id, run, now }: DraftContext) {
  return run(async (runtime) => {
    const { trip } = await findTrip(runtime, id);
    const draft = await readDraft(runtime, id);
    const needs_review =
      draft !== null &&
      (stale(draft, trip.revision, now()) ||
        !sameCandidates(draft.entries, await readCandidates(runtime, tripDetail(trip))));
    return { draft, needs_review };
  });
}

function saveDraft({ id, run, now }: DraftContext, draft: TripDraft, previous: TripDraft | null) {
  return run(async (runtime) => {
    const { key, trip } = await findTrip(runtime, id);
    const candidates = await readCandidates(runtime, tripDetail(trip));
    const scope = runtime.conversation.id;
    return runtime.conversation.commit(async (tx) => {
      const current = await tx.doc(Trips, scope, key, key);
      const pending = await tx.doc(Drafts, scope, id, id);
      if (
        !current.trip ||
        stale(draft, current.trip.revision, now()) ||
        !sameCandidates(draft.entries, candidates) ||
        !isVersion(pending.draft, previous)
      )
        throw new HttpFault('DRAFT_STALE');
      pending.draft = draft;
      return draft;
    }, BACKGROUND_CONTEXT);
  });
}

export async function generateDraft(context: DraftContext, revision: number) {
  const { id, run, now, map } = context;
  const { trip, previous, candidates } = await run(async (runtime) => {
    const trip = tripDetail((await findTrip(runtime, id)).trip);
    return {
      trip,
      previous: await readDraft(runtime, id),
      candidates: await readCandidates(runtime, trip),
    };
  });
  if (!trip.day) throw new TripFault('INVALID_TRIP_DAY');
  if (trip.revision !== revision) throw new HttpFault('DRAFT_STALE');
  if (previous && !stale(previous, revision, now()) && sameCandidates(previous.entries, candidates))
    return previous;
  const walking = draftWalking(map, now());
  const entries = await scheduleDraft({
    day: trip.day,
    arrangements: trip.arrangements,
    entries: candidates,
    walk: walking.walk,
  });
  return saveDraft(
    context,
    {
      draft_id: `draft-${randomUUID()}`,
      revision: 1,
      trip_revision: revision,
      day: trip.day,
      entries,
      expires_at: walking.expiresAt(),
    },
    previous,
  );
}

export async function editDraft(context: DraftContext, version: DraftVersion, edit: DraftEdit) {
  const { id, run, now, map } = context;
  const { trip, draft, candidates } = await run(async (runtime) => {
    const trip = tripDetail((await findTrip(runtime, id)).trip);
    return {
      trip,
      draft: await readDraft(runtime, id),
      candidates: await readCandidates(runtime, trip),
    };
  });
  if (
    !draft ||
    !isVersion(draft, version) ||
    stale(draft, trip.revision, now()) ||
    !sameCandidates(draft.entries, candidates)
  )
    throw new HttpFault('DRAFT_STALE');
  const changed = editDraftEntries(draft.entries, edit);
  if (!changed) throw new HttpFault('DRAFT_INVALID_EDIT');
  const walking = draftWalking(map, now());
  // Locking changes no times, so it can preserve the already reviewed schedule as-is.
  const entries =
    edit.kind === 'lock' && edit.locked
      ? changed
      : await scheduleDraft({
          day: draft.day,
          arrangements: trip.arrangements,
          entries: changed,
          walk: walking.walk,
        });
  return saveDraft(
    context,
    {
      ...draft,
      entries,
      revision: draft.revision + 1,
      expires_at: Math.min(draft.expires_at, walking.expiresAt()),
    },
    draft,
  );
}

export function applyDraft({ id, run, now }: DraftContext, version: DraftVersion) {
  return run(async (runtime) => {
    const { key, trip } = await findTrip(runtime, id);
    // This read shares the guest's single-writer lease with the commit below.
    const candidates = await readCandidates(runtime, tripDetail(trip));
    const scope = runtime.conversation.id;
    const draftKey = version.draft_id;
    await runtime.conversation.commit(async (tx) => {
      const recorded = await tx.doc(DraftReceipts, scope, draftKey, draftKey);
      if (recorded.receipt) {
        if (recorded.receipt.trip.trip_id !== id || recorded.receipt.revision !== version.revision)
          throw new HttpFault('DRAFT_STALE');
        return;
      }
      const current = await tx.doc(Trips, scope, key, key);
      const pending = await tx.doc(Drafts, scope, id, id);
      const draft = pending.draft;
      if (
        !current.trip?.day ||
        !draft ||
        !isVersion(draft, version) ||
        stale(draft, current.trip.revision, now()) ||
        !sameCandidates(draft.entries, candidates)
      )
        throw new HttpFault('DRAFT_STALE');
      const scheduled = draft.entries.filter((entry) => entry.kind === 'scheduled');
      if (!scheduled.length) throw new HttpFault('DRAFT_NO_SCHEDULE');
      const additions = scheduled.map(({ poi_id, name, address, start, end, locked }) => ({
        poi_id,
        name: name.trim(),
        address,
        start,
        end,
        locked,
        arrangement_id: `arrangement-${randomUUID()}`,
      }));
      const arrangements = [...(trip.arrangements ?? []), ...additions];
      const added = new Set(additions.map(({ arrangement_id }) => arrangement_id));
      const invalid = arrangementWarnings(draft.day, arrangements).some(
        (warning) =>
          warning.kind !== 'missing_location' &&
          (added.has(warning.arrangement_id) ||
            (warning.kind === 'overlap' && added.has(warning.other_id))),
      );
      if (invalid) throw new HttpFault('DRAFT_STALE');
      const updated = { ...trip, revision: trip.revision + 1, arrangements };
      current.trip = updated;
      recorded.receipt = { revision: version.revision, trip: tripDetail(updated) };
      pending.draft = null;
    }, BACKGROUND_CONTEXT);
    const saved = await runtime.harness.snapshot(
      DraftReceipts,
      scope,
      draftKey,
      BACKGROUND_CONTEXT,
    );
    if (!receiptState.check(saved) || !saved.receipt) throw new Error('Missing draft receipt');
    return saved.receipt.trip;
  });
}
