export function fitsTimeWindow(input: {
  available_min: number;
  travel_to_min: number;
  stay_min: number;
  travel_after_min: number;
  buffer_min: number;
}): boolean {
  if (!Object.values(input).every((value) => Number.isFinite(value) && value >= 0)) return false;
  return (
    input.travel_to_min + input.stay_min + input.travel_after_min + input.buffer_min <=
    input.available_min
  );
}
