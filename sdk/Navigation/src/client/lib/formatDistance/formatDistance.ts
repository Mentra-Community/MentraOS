/**
 * Compact distance string in metric units ("750 m", "1.2 km", "—" for unknown).
 * Switches from meters to kilometers at 1000 m. Clamps very-small values
 * to "1 m" so we never display "0 m".
 */
export function formatDistance(meters: number): string {
  if (meters < 0) return "—"
  if (meters < 1000) return `${Math.max(1, Math.round(meters))} m`
  const km = meters / 1000
  return `${km.toFixed(km < 10 ? 1 : 0)} km`
}

/** Compact duration string ("45 sec", "14 min", "1 h 5 min", "—" for unknown). */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return "—"
  if (seconds < 60) return `${seconds} sec`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin === 0 ? `${hours} h` : `${hours} h ${remMin} min`
}
