import { readFile } from 'node:fs/promises';
import { arr, compile, obj, oneOf, str, type Static } from '@earendil-works/pi-schema';
import { IdentifierSchema } from '@nextstop/core';

const BookingPolicySchema = arr(
  obj({
    poi_id: IdentifierSchema,
    state: oneOf(['required', 'not_required']),
    source: str({ minLength: 1, maxLength: 200 }),
    verified_at: str({ format: 'date-time' }),
    valid_until: str({ format: 'date-time' }),
  }),
);
type BookingPolicy = Static<typeof BookingPolicySchema>[number];
const validator = compile(BookingPolicySchema);

export async function readBookingPolicy(
  path: string | undefined,
): Promise<ReadonlyMap<string, BookingPolicy>> {
  if (!path) return new Map();
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!validator.check(data)) throw new Error('Invalid radar booking policy');
  const policies = new Map(data.map((entry) => [entry.poi_id, entry]));
  if (
    policies.size !== data.length ||
    data.some(({ verified_at, valid_until }) => Date.parse(verified_at) >= Date.parse(valid_until))
  )
    throw new Error('Invalid radar booking policy');
  return policies;
}

export function bookingEvidence(entry: BookingPolicy | undefined, at: number) {
  if (!entry) return undefined;
  return {
    state: entry.state,
    source: entry.source,
    status:
      at >= Date.parse(entry.verified_at) && at < Date.parse(entry.valid_until)
        ? ('verified' as const)
        : ('stale' as const),
  };
}
