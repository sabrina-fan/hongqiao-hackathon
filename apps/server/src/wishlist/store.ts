import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily, type Tx } from '@earendil-works/pi-durable';
import { compile, type Static } from '@earendil-works/pi-schema';
import {
  filterWishlist,
  StoredWishlistSchema,
  type EditWishlist,
  type SavedPlace,
  type Wishlist,
  type WishlistFilter,
  type WishlistPlace,
} from '@nextstop/core';
import { HttpFault } from '../http.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { readScheduledPoiIds } from '../trip/store.js';

type StoredWishlist = Static<typeof StoredWishlistSchema>;
type StoredPlace = StoredWishlist['places'][number];
const validator = compile(StoredWishlistSchema);
const Wishes = defineDocFamily<StoredWishlist, string>({
  kind: 'nextstop.wishlist',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  checkpointWhen: () => true,
  initial: () => ({ places: [] }),
});
const KEY = 'current';

async function readPlaces(runtime: UserRuntime): Promise<StoredPlace[]> {
  const state = await runtime.harness.snapshot(
    Wishes,
    runtime.conversation.id,
    KEY,
    BACKGROUND_CONTEXT,
  );
  if (!state) return [];
  if (!validator.check(state)) throw new Error('Invalid stored wishlist');
  return state.places;
}

async function wishlistDocument(runtime: UserRuntime, tx: Tx) {
  const state = await tx.doc(Wishes, runtime.conversation.id, KEY, KEY);
  if (!validator.check(state)) throw new Error('Invalid stored wishlist');
  return state;
}

type PlaceKey = Pick<WishlistPlace, 'provider' | 'poi_id'>;
const placeKey = ({ provider, poi_id }: PlaceKey) => `${provider}:${poi_id}`;

export async function checkWishlistNewCount({
  runtime,
  tx,
  selections,
  newCount,
}: {
  runtime: UserRuntime;
  tx: Tx;
  selections: PlaceKey[];
  newCount: number;
}) {
  const { places } = await wishlistDocument(runtime, tx);
  const known = new Set(places.map(placeKey));
  const added = new Set(selections.map(placeKey).filter((key) => !known.has(key)));
  if (added.size !== newCount) throw new HttpFault('IMPORT_STALE');
}

export async function saveWishlistSource({
  runtime,
  tx,
  incoming,
  preservePlaceDetails = false,
}: {
  runtime: UserRuntime;
  tx: Tx;
  incoming: WishlistPlace;
  preservePlaceDetails?: boolean;
}): Promise<WishlistPlace> {
  const state = await wishlistDocument(runtime, tx);
  const index = state.places.findIndex((place) => placeKey(place) === placeKey(incoming));
  const existing = state.places[index];
  const place = {
    ...incoming,
    ...(preservePlaceDetails && existing && { name: existing.name, address: existing.address }),
    sources: [...(existing?.sources ?? []).map((source) => ({ ...source })), ...incoming.sources],
  };
  if (existing) state.places[index] = { ...existing, ...place };
  else state.places.push(place);
  return place;
}

function present(place: StoredPlace, scheduled: ReadonlySet<string>): SavedPlace {
  return {
    ...place,
    visit: place.visit ?? 'unvisited',
    note: place.note ?? '',
    schedule: scheduled.has(place.poi_id) ? 'scheduled' : 'unscheduled',
    evidence: 'unknown',
  };
}

export async function readWishlist(
  runtime: UserRuntime,
  filter: WishlistFilter,
): Promise<Wishlist> {
  const places = await readPlaces(runtime);
  if (places.length === 0) return { places: [] };
  const scheduled = await readScheduledPoiIds(runtime);
  return {
    places: filterWishlist(
      places.map((place) => present(place, scheduled)),
      filter,
    ),
  };
}

export async function readSavedPlace(runtime: UserRuntime, poiId: string): Promise<SavedPlace> {
  const place = (await readPlaces(runtime)).find(({ poi_id }) => poi_id === poiId);
  if (!place) throw new HttpFault('WISHLIST_NOT_FOUND');
  return present(place, await readScheduledPoiIds(runtime));
}

export async function editSavedPlace(
  runtime: UserRuntime,
  poiId: string,
  edit: EditWishlist,
): Promise<SavedPlace> {
  const updated = await runtime.conversation.commit(async (tx) => {
    const { places } = await wishlistDocument(runtime, tx);
    const index = places.findIndex(({ poi_id }) => poi_id === poiId);
    const place = places[index];
    if (!place) throw new HttpFault('WISHLIST_NOT_FOUND');
    const value = { ...place, ...edit, sources: place.sources.map((source) => ({ ...source })) };
    places[index] = value;
    return value;
  }, BACKGROUND_CONTEXT);
  return present(updated, await readScheduledPoiIds(runtime));
}

export function removeSavedPlace(runtime: UserRuntime, poiId: string) {
  return runtime.conversation.commit(async (tx) => {
    const state = await wishlistDocument(runtime, tx);
    const index = state.places.findIndex(({ poi_id }) => poi_id === poiId);
    if (index === -1) throw new HttpFault('WISHLIST_NOT_FOUND');
    state.places.splice(index, 1);
  }, BACKGROUND_CONTEXT);
}
