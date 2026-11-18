import { tripDetailValidator, type TripDetail } from '@nextstop/core';

const tripKey = 'nextstop.offline-trip';
const changeKey = 'nextstop.data-change';
const changeEvent = 'nextstop:data-change';
export const radarPointerKey = 'nextstop.radar-session';
export const batchPointerKey = 'nextstop:last-import-batch';
const draftKeys = [radarPointerKey, batchPointerKey];

export function readRadarPointer() {
  try {
    return sessionStorage.getItem(radarPointerKey);
  } catch {
    return null;
  }
}

export function cacheGeneration() {
  try {
    return localStorage.getItem(changeKey);
  } catch {
    return null;
  }
}

export function readRecentTrip(): TripDetail | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(tripKey) ?? 'null');
    return tripDetailValidator.check(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberTrip(trip: TripDetail, generation: string | null) {
  try {
    if (generation === cacheGeneration()) localStorage.setItem(tripKey, JSON.stringify(trip));
  } catch {
    // A blocked browser store only disables offline readback.
  }
}

function clearPointers(scope: 'all' | 'trip') {
  try {
    for (const key of scope === 'all' ? draftKeys : draftKeys.slice(0, 1))
      sessionStorage.removeItem(key);
  } catch {
    // There is nothing to restore when storage is blocked.
  }
}

export function invalidateTripData(tripId: string | null, broadcast = true) {
  const scope = tripId === null ? 'all' : 'trip';
  try {
    if (scope === 'all' || readRecentTrip()?.trip_id === tripId) localStorage.removeItem(tripKey);
    if (broadcast) localStorage.setItem(changeKey, `${scope}:${crypto.randomUUID()}`);
  } catch {
    // In-memory data is invalidated by the event even if browser storage is blocked.
  }
  clearPointers(scope);
  if (broadcast) window.dispatchEvent(new Event(changeEvent));
}

export function watchTripData(onChange: () => void) {
  const storageChange = (event: StorageEvent) => {
    if (event.key !== changeKey && event.key !== null) return;
    clearPointers(event.newValue?.startsWith('trip:') ? 'trip' : 'all');
    onChange();
  };
  window.addEventListener(changeEvent, onChange);
  window.addEventListener('storage', storageChange);
  return () => {
    window.removeEventListener(changeEvent, onChange);
    window.removeEventListener('storage', storageChange);
  };
}
