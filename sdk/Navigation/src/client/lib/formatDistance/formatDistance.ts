/** Compact distance string ("750 m", "1.2 km", "—" for unknown). */
export function formatDistance(meters: number): string {
  if (meters < 0) return "—"
  if (meters < 1000) return `${meters} m`
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`
}
