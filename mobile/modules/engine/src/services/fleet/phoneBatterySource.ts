/**
 * Fleet's phone battery source over expo-battery: the level as a whole percent, and whether it is charging. Nothing
 * else the platform reports (low power mode, battery optimization) is read.
 *
 * expo-battery is asynchronous and its level listener cannot be relied on (on Android it fires only at the low and okay
 * thresholds), so the source holds the last reading and reads again only when asked: the collector asks on the
 * wake-ups it already has, so reading the battery adds none of its own.
 */
import type {PhoneBatteryReading, PhoneBatterySource} from "./fleetCollector"

/** The part of expo-battery the source reads. */
export interface PhoneBatteryPlatform {
  isAvailableAsync(): Promise<boolean>
  /** `batteryLevel` from 0 to 1, or -1 when unknown; `batteryState` is expo-battery's `BatteryState`. */
  getPowerStateAsync(): Promise<{batteryLevel: number; batteryState: number}>
}

/** expo-battery's `BatteryState.CHARGING` and `BatteryState.FULL`: plugged in. */
const CHARGING = 2
const FULL = 3

function warn(what: string, error: unknown): void {
  console.warn(`FleetPhoneBattery: ${what} failed:`, error instanceof Error ? error.message : "unknown error")
}

function readingOf(power: {batteryLevel: number; batteryState: number}): PhoneBatteryReading | null {
  const level = power.batteryLevel
  if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) return null
  return {level: Math.round(level * 100), charging: power.batteryState === CHARGING || power.batteryState === FULL}
}

const same = (a: PhoneBatteryReading | "unsupported" | null, b: PhoneBatteryReading | "unsupported" | null) =>
  a === b || (typeof a === "object" && typeof b === "object" && a?.level === b?.level && a?.charging === b?.charging)

/** `platform` may be a loader, called on the first refresh, so a build without the native module only warns. */
export function createPhoneBatterySource(platform: PhoneBatteryPlatform | (() => PhoneBatteryPlatform)): PhoneBatterySource {
  let loaded: PhoneBatteryPlatform | null = typeof platform === "function" ? null : platform
  let current: PhoneBatteryReading | "unsupported" | null = null
  let available: boolean | null = null
  let reading = false
  const listeners = new Set<() => void>()

  function settle(next: PhoneBatteryReading | "unsupported" | null): void {
    if (same(current, next)) return
    current = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        warn("phone battery listener", error)
      }
    }
  }

  async function read(): Promise<void> {
    try {
      loaded ??= (platform as () => PhoneBatteryPlatform)()
      available ??= await loaded.isAvailableAsync()
      if (!available) return settle("unsupported")
      settle(readingOf(await loaded.getPowerStateAsync()))
    } catch (error) {
      warn("reading the phone battery", error)
    } finally {
      reading = false
    }
  }

  return {
    read: () => current,
    refresh() {
      if (reading || current === "unsupported") return
      reading = true
      void read()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

/** The app's source. expo-battery is loaded on the first refresh. */
export const appPhoneBattery: PhoneBatterySource = createPhoneBatterySource(
  () => require("expo-battery") as PhoneBatteryPlatform,
)
