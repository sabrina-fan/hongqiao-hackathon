export function fitsTimeWindow({
  available_min,
  travel_to_min,
  stay_min,
  travel_after_min,
  buffer_min,
}: {
  available_min: number;
  travel_to_min: number;
  stay_min: number;
  travel_after_min: number;
  buffer_min: number;
}): boolean {
  const times = [available_min, travel_to_min, stay_min, travel_after_min, buffer_min];
  if (!times.every((value) => Number.isFinite(value) && value >= 0)) return false;
  return travel_to_min + stay_min + travel_after_min + buffer_min <= available_min;
}
