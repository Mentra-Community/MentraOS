import type {UnitSystem} from "../../shared/types"

const FEET_PER_METER = 3.28084
const FEET_PER_MILE = 5280

/**
 * Compact distance string in the requested unit system.
 *
 *   metric   → "750 m", "1.2 km"   (m below 1000 m, then km)
 *   imperial → "820 ft", "0.8 mi"  (ft below 0.1 mi ≈ 528 ft, then mi)
 *
 * "—" for unknown (negative) input. Clamps very-small values to the
 * smallest whole unit ("1 m" / "1 ft") so we never display "0 m". The
 * `unit` param defaults to "metric" so legacy call sites stay valid.
 */
export function formatDistance(meters: number, unit: UnitSystem = "metric"): string {
  if (meters < 0) return "—"
  if (unit === "imperial") {
    const feet = meters * FEET_PER_METER
    // Switch to miles once we're past ~0.1 mi so short distances stay
    // legible in feet rather than rounding to "0.0 mi".
    if (feet < FEET_PER_MILE * 0.1) return `${Math.max(1, Math.round(feet))} ft`
    const miles = feet / FEET_PER_MILE
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`
  }
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
