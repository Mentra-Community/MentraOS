import type {RegistryEntry} from "./MiniappRunningRegistry"

/**
 * Phase 0 — Device-tier eviction policy for backgrounded miniapp WebViews.
 *
 * iOS jetsam kills the host process once total WebKit overhead crosses the
 * device's memory ceiling. Per-WebContent baseline is ~80–150 MB and not
 * tunable, so the only knob we have is "how many backgrounded WebViews do
 * we keep warm at a time." Capacity numbers are derived from the iPhone 15
 * release-build benchmark (10 backgrounded WebViews jetsam'd within ~1s),
 * extrapolated linearly down by physical RAM.
 *
 * This whole file is throwaway scaffolding — Phase 3 inverts the WebView
 * lifecycle to spawn-on-demand, at which point there's nothing left to
 * evict. The PURE eviction-policy function below survives into Phase 3 as
 * a unit-testable building block for any future capacity logic (e.g.
 * "max N concurrent JSContexts on this device"); the wiring inside
 * MiniappHost gets deleted.
 *
 * Android is explicitly out of scope for V1 — multiple Android WebViews
 * share one renderer process, so the jetsam wall doesn't apply. The
 * Android host still calls `getDeviceTierBackgroundSlots` but the native
 * `physicalMemory` shim returns 0, which maps to "unlimited" below.
 */

/** Capacity buckets for **backgrounded** WebViews. The foreground app is always allowed. */
export interface DeviceTier {
  /** Inclusive lower bound, in bytes. */
  minBytes: number
  /** Backgrounded WebView slots. Foreground app is in addition. */
  backgroundSlots: number
  /** Human-readable label for logs / telemetry. */
  label: string
}

/**
 * Tiers ordered from smallest to largest. Looked up by walking the table
 * top-down and picking the last row whose `minBytes` is ≤ the device's
 * `physicalMemory`. The top row is the catch-all for SE-class devices;
 * the bottom row is "8 GB+".
 *
 * Spec canonical table (Phase 0 task list):
 *   3 GB → 1, 4 GB → 3, 6 GB → 5, 8 GB+ → 8
 *
 * `ProcessInfo.physicalMemory` reports a hair less than the marketed RAM
 * (OS reserves a slice), so the breakpoints sit just below the round
 * marketing numbers — e.g. 5.5 GB catches "6 GB" devices, 7.5 GB catches
 * "8 GB" devices. Conservative on purpose: we'd rather evict a little
 * early than jetsam unexpectedly.
 */
export const DEVICE_TIERS: ReadonlyArray<DeviceTier> = [
  {minBytes: 0, backgroundSlots: 1, label: "≤3 GB (SE 2 class)"},
  {minBytes: 3.5 * 1024 ** 3, backgroundSlots: 3, label: "≤6 GB (SE 3 / iPhone 12 / 13)"},
  {minBytes: 5.5 * 1024 ** 3, backgroundSlots: 5, label: "≤8 GB (iPhone 14 / 15)"},
  {minBytes: 7.5 * 1024 ** 3, backgroundSlots: 8, label: "8 GB+ (Pro Max class)"},
] as const

/**
 * `physicalMemory === 0` represents "unknown / not measured" (Android stub,
 * test environment, web fallback). Treated as effectively unlimited so the
 * policy never evicts on platforms where the spec says it shouldn't apply.
 */
export const UNLIMITED_BACKGROUND_SLOTS = Number.POSITIVE_INFINITY

/**
 * Bucket the device's physical memory into a tier.
 *
 * `physicalMemoryBytes <= 0` is "unknown" (Android stub, web, test) and
 * yields `UNLIMITED_BACKGROUND_SLOTS` so callers can short-circuit eviction.
 *
 * Otherwise returns the number of background slots available on the
 * matching tier. The caller is responsible for tracking the foreground app
 * separately — the foreground slot is implicit and never counted here.
 */
export function getDeviceTierBackgroundSlots(physicalMemoryBytes: number): number {
  if (!Number.isFinite(physicalMemoryBytes) || physicalMemoryBytes <= 0) {
    return UNLIMITED_BACKGROUND_SLOTS
  }
  let chosen = DEVICE_TIERS[0]
  for (const tier of DEVICE_TIERS) {
    if (physicalMemoryBytes >= tier.minBytes) chosen = tier
    else break
  }
  return chosen.backgroundSlots
}

export function getDeviceTierLabel(physicalMemoryBytes: number): string {
  if (!Number.isFinite(physicalMemoryBytes) || physicalMemoryBytes <= 0) {
    return "unknown (eviction disabled)"
  }
  let chosen = DEVICE_TIERS[0]
  for (const tier of DEVICE_TIERS) {
    if (physicalMemoryBytes >= tier.minBytes) chosen = tier
    else break
  }
  return chosen.label
}

export interface EvictionInput {
  /** Full registry snapshot — every mounted miniapp, foreground or background. */
  entries: ReadonlyArray<RegistryEntry>
  /**
   * PackageName currently held in the foreground, or null when no app is in
   * the foreground (e.g. user is on a non-miniapp screen). The foreground
   * app is never a candidate for eviction.
   */
  foregroundPackage: string | null
  /**
   * Number of backgrounded slots the device tier permits. Use
   * `UNLIMITED_BACKGROUND_SLOTS` to disable eviction. Non-finite or
   * negative values are coerced to 0.
   */
  capacity: number
}

/**
 * Pure function. Given the current registry and the device's tier capacity,
 * returns the packageNames to evict, ordered oldest-foregrounded first.
 *
 * Selection rules:
 *   1. The foreground app is excluded.
 *   2. All other mounted apps are candidates.
 *   3. Candidates are ordered ascending by `lastForegroundAt`. Apps that
 *      have never been foregrounded (timestamp = 0) sort first. Ties break
 *      on packageName for deterministic test output.
 *   4. We evict the oldest until backgrounded count <= capacity.
 *
 * Returns an empty array when no eviction is required. Callers should treat
 * the returned list as a *targets* list — they still need to perform the
 * teardown (beforeevict envelope, unmount, telemetry counter).
 */
export function selectMiniappsToEvict(input: EvictionInput): string[] {
  if (input.capacity === UNLIMITED_BACKGROUND_SLOTS) return []
  const capacity = Math.max(0, Math.floor(input.capacity))

  const backgrounded = input.entries.filter((e) => e.packageName !== input.foregroundPackage)
  if (backgrounded.length <= capacity) return []

  const sorted = [...backgrounded].sort((a, b) => {
    if (a.lastForegroundAt !== b.lastForegroundAt) {
      return a.lastForegroundAt - b.lastForegroundAt
    }
    return a.packageName.localeCompare(b.packageName)
  })

  const targets = sorted.slice(0, backgrounded.length - capacity)
  return targets.map((e) => e.packageName)
}
