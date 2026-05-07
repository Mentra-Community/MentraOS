/** Compact distance string ("750 m", "1.2 km", "—" for unknown). */
export function formatDistance(meters: number): string {
  if (meters < 0) return "—"
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`
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
