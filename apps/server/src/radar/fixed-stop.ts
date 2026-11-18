import type { Arrangement, FixedStop, TripDay } from '@nextstop/core';
import { RadarFault } from './evidence.js';

function wallClock(timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (at: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(at).map(({ type, value }) => [type, value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
}

function epochOf(wall: string, local: ReturnType<typeof wallClock>) {
  const naive = Date.parse(`${wall}Z`);
  const day = 86_400_000;
  // Check offsets on both sides of the date. A repeated wall time uses its earlier occurrence.
  const matches = [naive - day, naive, naive + day]
    .map((sample) => naive - (Date.parse(`${local(sample)}Z`) - sample))
    .filter((candidate) => local(candidate) === wall);
  if (!matches.length) throw new RadarFault('FIXED_TIME_INVALID');
  return Math.min(...matches);
}

export function nextFixedStop(
  trip: { day?: TripDay | null; arrangements?: Arrangement[] } | null,
  at: number,
): FixedStop | null {
  if (!trip?.day) return null;
  const { date, time_zone } = trip.day;
  const local = wallClock(time_zone);
  if (!local(at).startsWith(`${date}T`)) return null;
  const locked = (trip.arrangements ?? [])
    .filter(({ locked }) => locked)
    .map(({ arrangement_id, name, address, start, end }) => ({
      arrangement_id,
      name,
      address,
      start: epochOf(`${date}T${start}`, local),
      end: epochOf(`${date}T${end}`, local),
    }))
    .filter(({ end }) => at < end)
    .sort((a, b) => a.start - b.start);
  const item = locked[0];
  if (!item) return null;
  return {
    arrangement_id: item.arrangement_id,
    name: item.name,
    address: item.address,
    starts_at: new Date(item.start).toISOString(),
    time_zone,
  };
}

export function effectiveFixed(
  fixed: FixedStop | null,
  mode: 'next_locked' | 'without_fixed' | undefined,
  at: number,
) {
  if (!fixed) return null;
  if (!fixed.address && Date.parse(fixed.starts_at) > at) {
    if (mode === 'without_fixed') return null;
    throw new RadarFault('FIXED_LOCATION_REQUIRED');
  }
  return fixed;
}
