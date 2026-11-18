export function radarWindow({
  started_ms,
  manual_min,
  fixed_ms,
}: {
  started_ms: number;
  manual_min: number;
  fixed_ms: number | null;
}) {
  const manualDeadline = started_ms + manual_min * 60_000;
  const deadline_ms = Math.min(manualDeadline, fixed_ms ?? manualDeadline);
  const limited_by =
    fixed_ms === manualDeadline ? 'both' : deadline_ms < manualDeadline ? 'fixed' : 'manual';
  return {
    deadline_ms,
    limited_by,
    available_min: Math.max(0, Math.floor((deadline_ms - started_ms) / 60_000)),
  } satisfies {
    deadline_ms: number;
    limited_by: 'both' | 'fixed' | 'manual';
    available_min: number;
  };
}
