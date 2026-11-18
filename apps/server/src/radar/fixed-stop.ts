import type { Arrangement, FixedStop, RadarContext, RadarRequest, TripDay } from '@nextstop/core';
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

type ScheduledTrip = { day?: TripDay | null; arrangements?: Arrangement[] } | null;
type ScheduledLock = Pick<Arrangement, 'arrangement_id' | 'name' | 'address'> & {
  start: number;
  end: number;
  time_zone: string;
};

function fixedSchedule(trip: ScheduledTrip, at: number) {
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
      time_zone,
      start: epochOf(`${date}T${start}`, local),
      end: epochOf(`${date}T${end}`, local),
    }))
    .sort((a, b) => a.start - b.start);
  return {
    active: locked.find(({ start, end }) => start <= at && at < end),
    next: locked.find(({ start }) => at < start),
  };
}

function fixedStop({ arrangement_id, name, address, start, time_zone }: ScheduledLock): FixedStop {
  return { arrangement_id, name, address, starts_at: new Date(start).toISOString(), time_zone };
}

export function fixedContext(trip: ScheduledTrip, at: number): RadarContext {
  const { active, next } = fixedSchedule(trip, at) ?? {};
  return {
    fixed: next ? fixedStop(next) : null,
    in_progress: active
      ? {
          arrangement_id: active.arrangement_id,
          name: active.name,
          ends_at: new Date(active.end).toISOString(),
          time_zone: active.time_zone,
        }
      : null,
  };
}

export function fixedForSearch(trip: ScheduledTrip, mode: RadarRequest['fixed_mode'], at: number) {
  const { active, next } = fixedSchedule(trip, at) ?? {};
  if (active) throw new RadarFault('FIXED_IN_PROGRESS');
  if (!next) return null;
  if (!next.address) {
    if (mode === 'without_fixed') return null;
    throw new RadarFault('FIXED_LOCATION_REQUIRED');
  }
  return fixedStop(next);
}
