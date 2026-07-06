/**
 * Drop null/undefined and empty objects from outbound JSON payloads.
 * v1-safe wire savings where receivers treat missing keys as defaults.
 */
export function omitEmptyJsonFields<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0
    ) {
      continue
    }
    out[key] = value
  }
  return out as Partial<T>
}
