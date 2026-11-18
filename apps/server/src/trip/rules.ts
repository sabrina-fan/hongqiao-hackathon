import type { Arrangement, ArrangementWarning, TripDay } from '@nextstop/core';

export function validInterval({ start, end }: Pick<TripDay, 'start' | 'end'>): boolean {
  return start < end;
}

export function validTripDay(day: TripDay): boolean {
  const date = new Date(`${day.date}T00:00:00Z`);
  if (
    !validInterval(day) ||
    !Number.isFinite(date.getTime()) ||
    !date.toISOString().startsWith(day.date)
  )
    return false;
  if (!/^[a-z][a-z0-9_+/-]*$/i.test(day.time_zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: day.time_zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function arrangementWarnings(
  day: TripDay,
  arrangements: Arrangement[],
): ArrangementWarning[] {
  const warnings: ArrangementWarning[] = [];
  for (const [index, item] of arrangements.entries()) {
    const { arrangement_id, start, end, address } = item;
    if (!address.trim()) warnings.push({ kind: 'missing_location', arrangement_id });
    if (start < day.start || end > day.end)
      warnings.push({ kind: 'outside_trip_hours', arrangement_id });
    for (const other of arrangements.slice(index + 1)) {
      if (start < other.end && other.start < end) {
        warnings.push({ kind: 'overlap', arrangement_id, other_id: other.arrangement_id });
      }
    }
  }
  return warnings;
}
