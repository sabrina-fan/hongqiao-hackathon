import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, Tx } from '@earendil-works/pi-durable';
import type { ArrangementInput, TripDay, TripDetail, TripList, TripView } from '@nextstop/core';
import { randomUUID } from 'node:crypto';
import {
  TripDirectory,
  Trips,
  tripDirectoryValidator,
  tripStateValidator,
  type TripState,
} from '../runtime/documents.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { arrangementWarnings, validInterval, validTripDay } from './rules.js';

// Existing radar-only trips live at this key even though their public ID differs.
const LEGACY_KEY = 'current';
const DIRECTORY_KEY = 'directory';

type StoredTrip = NonNullable<TripState['trip']>;
export class TripFault extends Error {
  constructor(
    readonly code:
      | 'TRIP_NOT_FOUND'
      | 'TRIP_STALE'
      | 'INVALID_TRIP_DAY'
      | 'INVALID_ARRANGEMENT_TIME',
  ) {
    super(code);
  }
}

async function readKeys(runtime: UserRuntime): Promise<string[]> {
  const directory = await runtime.harness.snapshot(
    TripDirectory,
    runtime.conversation.id,
    DIRECTORY_KEY,
    BACKGROUND_CONTEXT,
  );
  if (!directory) return [];
  if (!tripDirectoryValidator.check(directory)) throw new Error('Invalid trip directory');
  return directory.keys;
}

async function readTrip(runtime: UserRuntime, key: string): Promise<StoredTrip | null> {
  const record = await runtime.harness.snapshot(
    Trips,
    runtime.conversation.id,
    key,
    BACKGROUND_CONTEXT,
  );
  if (!record) return null;
  if (!tripStateValidator.check(record)) throw new Error('Invalid stored trip');
  return record.trip;
}

export async function activeTripDocument(
  tx: Tx,
  conversationId: ConversationId,
): Promise<TripState> {
  const directory = await tx.doc(TripDirectory, conversationId, DIRECTORY_KEY, DIRECTORY_KEY);
  const key = directory.keys[0] ?? LEGACY_KEY;
  return tx.doc(Trips, conversationId, key, key);
}

export async function readActiveTrip(runtime: UserRuntime) {
  const [current] = await readKeys(runtime);
  return readTrip(runtime, current ?? LEGACY_KEY);
}

export async function getTrip({ runtime }: { runtime: UserRuntime }): Promise<TripView | null> {
  const trip = await readActiveTrip(runtime);
  if (!trip) return null;
  const { trip_id, revision, stops } = trip;
  return { trip_id, revision, stops };
}

export async function readScheduledPoiIds(runtime: UserRuntime): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const key of [...(await readKeys(runtime)), LEGACY_KEY]) {
    const trip = await readTrip(runtime, key);
    for (const stop of trip?.stops ?? []) ids.add(stop.poi_id);
    for (const arrangement of trip?.arrangements ?? []) {
      if (arrangement.poi_id !== undefined) ids.add(arrangement.poi_id);
    }
  }
  return ids;
}

export function tripDetail(trip: StoredTrip): TripDetail {
  const { trip_id, revision, stops, day, arrangements = [] } = trip;
  return {
    trip_id,
    revision,
    stops,
    day: day ?? null,
    arrangements,
    warnings: day ? arrangementWarnings(day, arrangements) : [],
  };
}

export async function listTrips(runtime: UserRuntime): Promise<TripList> {
  const keys = await readKeys(runtime);
  const trips: TripList['trips'] = [];
  for (const key of [...keys, LEGACY_KEY]) {
    const trip = await readTrip(runtime, key);
    if (trip) trips.push({ trip_id: trip.trip_id, revision: trip.revision, day: trip.day ?? null });
  }
  return { current_trip_id: trips[0]?.trip_id ?? null, trips };
}

function keyForTrip(keys: string[], id: string) {
  return keys.includes(id) ? id : LEGACY_KEY;
}

export async function tripInTransaction(tx: Tx, conversationId: ConversationId, id: string) {
  const directory = await tx.doc(TripDirectory, conversationId, DIRECTORY_KEY, DIRECTORY_KEY);
  const key = keyForTrip(directory.keys, id);
  const document = await tx.doc(Trips, conversationId, key, key);
  const { trip } = document;
  if (trip?.trip_id !== id) throw new TripFault('TRIP_NOT_FOUND');
  return trip;
}

export async function findTrip(runtime: UserRuntime, id: string) {
  const key = keyForTrip(await readKeys(runtime), id);
  const trip = await readTrip(runtime, key);
  if (trip?.trip_id !== id) throw new TripFault('TRIP_NOT_FOUND');
  return { key, trip };
}

export async function getTripDetail(runtime: UserRuntime, id: string): Promise<TripDetail> {
  return tripDetail((await findTrip(runtime, id)).trip);
}

export async function createTrip(runtime: UserRuntime, day: TripDay): Promise<TripDetail> {
  if (!validTripDay(day)) throw new TripFault('INVALID_TRIP_DAY');
  const trip_id = `trip-${randomUUID()}`;
  const trip = { trip_id, revision: 1, stops: [], day };
  const conversationId = runtime.conversation.id;
  await runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(Trips, conversationId, trip_id, trip_id);
    const directory = await tx.doc(TripDirectory, conversationId, DIRECTORY_KEY, DIRECTORY_KEY);
    record.trip = trip;
    directory.keys.unshift(trip_id);
  }, BACKGROUND_CONTEXT);
  return tripDetail(trip);
}

async function updateTrip({
  runtime,
  id,
  revision,
  change,
}: {
  runtime: UserRuntime;
  id: string;
  revision: number;
  change: (trip: StoredTrip) => StoredTrip;
}): Promise<TripDetail> {
  const { key, trip } = await findTrip(runtime, id);
  const conversationId = runtime.conversation.id;
  return runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(Trips, conversationId, key, key);
    if (record.trip?.trip_id !== id || record.trip.revision !== revision)
      throw new TripFault('TRIP_STALE');
    const updated = { ...change(trip), revision: revision + 1 };
    record.trip = updated;
    return tripDetail(updated);
  }, BACKGROUND_CONTEXT);
}

export function editTrip(runtime: UserRuntime, id: string, revision: number, day: TripDay) {
  if (!validTripDay(day)) throw new TripFault('INVALID_TRIP_DAY');
  return updateTrip({ runtime, id, revision, change: (trip) => ({ ...trip, day }) });
}

export function saveArrangement({
  runtime,
  id,
  revision,
  arrangement,
  arrangementId,
}: {
  runtime: UserRuntime;
  id: string;
  revision: number;
  arrangement: ArrangementInput;
  arrangementId: string | undefined;
}) {
  if (!validInterval(arrangement)) throw new TripFault('INVALID_ARRANGEMENT_TIME');
  return updateTrip({
    runtime,
    id,
    revision,
    change(trip) {
      if (!trip.day) throw new TripFault('INVALID_TRIP_DAY');
      const arrangements = trip.arrangements ?? [];
      const prior = arrangements.find(({ arrangement_id }) => arrangement_id === arrangementId);
      if (arrangementId && !prior) throw new TripFault('TRIP_NOT_FOUND');
      const address = arrangement.address.trim();
      const item = {
        ...arrangement,
        address,
        arrangement_id: arrangementId ?? `arrangement-${randomUUID()}`,
        ...(prior?.poi_id && prior.address === address ? { poi_id: prior.poi_id } : {}),
      };
      return {
        ...trip,
        arrangements: arrangementId
          ? arrangements.map((prior) => (prior.arrangement_id === arrangementId ? item : prior))
          : [...arrangements, item],
      };
    },
  });
}
