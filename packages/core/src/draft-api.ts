import {
  arr,
  bool,
  compile,
  int,
  lit,
  nullable,
  obj,
  str,
  union,
  type Static,
} from '@earendil-works/pi-schema';
import { IdentifierSchema, RevisionSchema } from './contracts.js';
import { LocalTimeSchema, TripDaySchema } from './trip-api.js';

const placeFields = {
  poi_id: IdentifierSchema,
  name: str({ minLength: 1, maxLength: 200 }),
  address: str({ maxLength: 500 }),
};
const DraftEntry = union([
  obj({
    ...placeFields,
    kind: lit('scheduled'),
    start: LocalTimeSchema,
    end: LocalTimeSchema,
    locked: bool(),
    stay_min: int({ minimum: 1 }),
  }),
  obj({
    ...placeFields,
    kind: lit('unscheduled'),
    reason: union([
      lit('time_conflict'),
      lit('walking_unknown'),
      lit('capacity'),
      lit('other_city'),
    ]),
  }),
  obj({ ...placeFields, kind: lit('skipped') }),
]);
export type DraftEntry = Static<typeof DraftEntry>;
const draftVersion = { draft_id: IdentifierSchema, revision: RevisionSchema };
export const TripDraftSchema = obj({
  ...draftVersion,
  trip_revision: RevisionSchema,
  day: TripDaySchema,
  expires_at: int({ minimum: 0 }),
  entries: arr(DraftEntry),
});
export type TripDraft = Static<typeof TripDraftSchema>;
export const tripDraftValidator = compile(TripDraftSchema);
export const draftReadValidator = compile(
  obj({ draft: nullable(TripDraftSchema), needs_review: bool() }),
);
export const draftGenerateValidator = compile(obj({ revision: RevisionSchema }));
const DraftVersionSchema = obj(draftVersion);
export const draftApplyValidator = compile(DraftVersionSchema);
export type DraftVersion = Static<typeof DraftVersionSchema>;
const DraftEdit = union([
  obj({ kind: lit('move'), poi_id: IdentifierSchema, direction: union([lit('up'), lit('down')]) }),
  obj({ kind: lit('skip'), poi_id: IdentifierSchema }),
  obj({ kind: lit('restore'), poi_id: IdentifierSchema }),
  obj({ kind: lit('lock'), poi_id: IdentifierSchema, locked: bool() }),
]);
export type DraftEdit = Static<typeof DraftEdit>;
export const draftEditValidator = compile(obj({ ...draftVersion, edit: DraftEdit }));

export function isDraftLocked(
  entry: DraftEntry,
): entry is Extract<DraftEntry, { kind: 'scheduled' }> & { locked: true } {
  return entry.kind === 'scheduled' && entry.locked;
}

export function canAdjustDraftEntry(entry: DraftEntry): boolean {
  if (entry.kind === 'scheduled') return !entry.locked;
  return (
    entry.kind === 'unscheduled' &&
    (entry.reason === 'time_conflict' || entry.reason === 'walking_unknown')
  );
}

export function draftMoveTarget(
  entries: DraftEntry[],
  index: number,
  direction: 'up' | 'down',
): number | null {
  const entry = entries[index];
  if (!entry || !canAdjustDraftEntry(entry)) return null;
  const step = direction === 'up' ? -1 : 1;
  for (let target = index + step; target >= 0 && target < entries.length; target += step) {
    const peer = entries[target];
    if (!peer || isDraftLocked(peer)) return null;
    if (canAdjustDraftEntry(peer)) return target;
  }
  return null;
}
