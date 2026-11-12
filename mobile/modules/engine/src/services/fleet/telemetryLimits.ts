/**
 * The Mentra App's limits on a miniapp's own events (Fleet spec, Miniapp telemetry), applied before an event is
 * queued. MFM checks them again and rejects what still breaks one, so nothing here may let a bad record through.
 *
 * - An event whose name is not 1-64 lowercase letters, digits and underscores, starting with a letter, is dropped.
 * - A property whose name breaks the same rule, or whose value is not a finite number, a boolean or a string, is
 *   dropped; a string longer than 64 characters is cut to 64. Only the first 25 properties, in the order given, are
 *   kept. What was dropped and cut is counted on the event.
 * - A miniapp sends at most 60 events a minute and 2,000 a UTC day from this phone; the rest are dropped.
 *
 * Every drop of a whole event is counted by the caller as the miniapp's `overLimit` loss.
 */
import {FLEET_TELEMETRY_LIMITS, FLEET_TELEMETRY_NAME} from "@mentra/cloud-protocol"

export interface LimitedEvent {
  event: string
  properties: Record<string, string | number | boolean>
  droppedProperties: number
  cutValues: number
}

/** Cuts a string to at most `max` UTF-16 code units without splitting a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  const end = value.charCodeAt(max - 1)
  return value.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max)
}

const isName = (value: unknown): value is string => typeof value === "string" && FLEET_TELEMETRY_NAME.test(value)

/** The event as it may be queued, or null when it must be dropped whole. Never throws. */
export function limitEvent(event: unknown, properties: unknown): LimitedEvent | null {
  if (!isName(event)) return null
  const kept: Record<string, string | number | boolean> = {}
  let droppedProperties = 0
  let cutValues = 0
  let count = 0
  const entries =
    properties !== null && typeof properties === "object" && !Array.isArray(properties) ? Object.entries(properties as Record<string, unknown>) : []
  for (const [name, value] of entries) {
    const valid = isName(name) && ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || typeof value === "string")
    if (!valid || count >= FLEET_TELEMETRY_LIMITS.maxProperties || name in kept) {
      droppedProperties += 1
      continue
    }
    if (typeof value === "string" && value.length > FLEET_TELEMETRY_LIMITS.maxStringValueLength) {
      kept[name] = cut(value, FLEET_TELEMETRY_LIMITS.maxStringValueLength)
      cutValues += 1
    } else kept[name] = value as string | number | boolean
    count += 1
  }
  return {event, properties: kept, droppedProperties, cutValues}
}

const MINUTE_MS = 60_000
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10)

/** Each miniapp's rate on this phone: 60 events in any minute and 2,000 a UTC day. Kept in memory. */
export class TelemetryRate {
  private readonly recent = new Map<string, number[]>()
  private readonly daily = new Map<string, {day: string; count: number}>()

  /** Whether `packageName` may send one more event at `at`; counts it when it may. */
  admit(packageName: string, at: number): boolean {
    const times = (this.recent.get(packageName) ?? []).filter((time) => at - time < MINUTE_MS && time <= at)
    const day = utcDay(at)
    const today = this.daily.get(packageName)
    const sent = today?.day === day ? today.count : 0
    if (times.length >= FLEET_TELEMETRY_LIMITS.eventsPerMinute || sent >= FLEET_TELEMETRY_LIMITS.eventsPerDay) {
      this.recent.set(packageName, times)
      return false
    }
    times.push(at)
    this.recent.set(packageName, times)
    this.daily.set(packageName, {day, count: sent + 1})
    return true
  }
}
