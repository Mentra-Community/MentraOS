import {
  DEVICE_TIERS,
  UNLIMITED_BACKGROUND_SLOTS,
  getDeviceTierBackgroundSlots,
  getDeviceTierLabel,
  selectMiniappsToEvict,
} from "../MiniappEvictionPolicy"
import type {RegistryEntry} from "../MiniappRunningRegistry"

const entry = (packageName: string, lastForegroundAt: number): RegistryEntry => ({packageName, lastForegroundAt})

describe("getDeviceTierBackgroundSlots", () => {
  test("returns UNLIMITED when physicalMemory is 0 (Android stub / unknown)", () => {
    expect(getDeviceTierBackgroundSlots(0)).toBe(UNLIMITED_BACKGROUND_SLOTS)
  })

  test("returns UNLIMITED when physicalMemory is negative", () => {
    expect(getDeviceTierBackgroundSlots(-1)).toBe(UNLIMITED_BACKGROUND_SLOTS)
  })

  test("returns UNLIMITED when physicalMemory is NaN / Infinity", () => {
    expect(getDeviceTierBackgroundSlots(Number.NaN)).toBe(UNLIMITED_BACKGROUND_SLOTS)
    expect(getDeviceTierBackgroundSlots(Number.POSITIVE_INFINITY)).toBe(UNLIMITED_BACKGROUND_SLOTS)
  })

  test("3 GB → 1 background slot (SE 2 class)", () => {
    expect(getDeviceTierBackgroundSlots(3 * 1024 ** 3)).toBe(1)
  })

  test("4 GB → 3 background slots (SE 3 / iPhone 12)", () => {
    expect(getDeviceTierBackgroundSlots(4 * 1024 ** 3)).toBe(3)
  })

  test("6 GB → 5 background slots (iPhone 14/15)", () => {
    expect(getDeviceTierBackgroundSlots(6 * 1024 ** 3)).toBe(5)
  })

  test("8 GB → 8 background slots (Pro Max class)", () => {
    expect(getDeviceTierBackgroundSlots(8 * 1024 ** 3)).toBe(8)
  })

  test("12 GB → 8 background slots (catch-all)", () => {
    expect(getDeviceTierBackgroundSlots(12 * 1024 ** 3)).toBe(8)
  })

  test("just-under-tier-breakpoint stays on lower tier", () => {
    // 5.4 GB reports as a 6 GB device with OS reserve; sits below the 5.5 GB breakpoint.
    expect(getDeviceTierBackgroundSlots(5.4 * 1024 ** 3)).toBe(3)
  })

  test("each tier is monotonically non-decreasing in slot count", () => {
    let prev = -Infinity
    for (const tier of DEVICE_TIERS) {
      expect(tier.backgroundSlots).toBeGreaterThanOrEqual(prev)
      prev = tier.backgroundSlots
    }
  })

  test("tier minBytes are strictly increasing (no overlap)", () => {
    let prev = -Infinity
    for (const tier of DEVICE_TIERS) {
      expect(tier.minBytes).toBeGreaterThan(prev)
      prev = tier.minBytes
    }
  })
})

describe("getDeviceTierLabel", () => {
  test("unknown for 0 bytes", () => {
    expect(getDeviceTierLabel(0)).toBe("unknown (eviction disabled)")
  })

  test("returns the matched tier's label for a known size", () => {
    expect(getDeviceTierLabel(6 * 1024 ** 3)).toContain("iPhone 14")
  })
})

describe("selectMiniappsToEvict", () => {
  test("returns empty when no apps", () => {
    expect(
      selectMiniappsToEvict({
        entries: [],
        foregroundPackage: null,
        capacity: 3,
      }),
    ).toEqual([])
  })

  test("returns empty when under capacity", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 1), entry("b", 2)],
        foregroundPackage: "a",
        capacity: 3,
      }),
    ).toEqual([])
  })

  test("returns empty when capacity is UNLIMITED, even if many apps are open", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 1), entry("b", 2), entry("c", 3), entry("d", 4)],
        foregroundPackage: "a",
        capacity: UNLIMITED_BACKGROUND_SLOTS,
      }),
    ).toEqual([])
  })

  test("evicts the oldest backgrounded when one slot over capacity", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 100), entry("b", 50), entry("c", 200)],
        foregroundPackage: "c",
        capacity: 1,
      }),
    ).toEqual(["b"])
  })

  test("evicts multiple when several slots over capacity, oldest-first", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 10), entry("b", 20), entry("c", 30), entry("d", 40), entry("e", 50)],
        foregroundPackage: "e",
        capacity: 1,
      }),
    ).toEqual(["a", "b", "c"])
  })

  test("foreground app is never evicted even if it has the oldest timestamp", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 1), entry("b", 100), entry("c", 200)],
        foregroundPackage: "a",
        capacity: 1,
      }),
    ).toEqual(["b"])
  })

  test("apps never foregrounded (timestamp 0) sort first", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("warm", 1000), entry("cold-new", 0), entry("cold-also", 0)],
        foregroundPackage: "warm",
        capacity: 1,
      }),
    ).toEqual(["cold-also"])
  })

  test("ties on lastForegroundAt break by packageName ascending (deterministic)", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("z", 100), entry("y", 100), entry("x", 100), entry("fg", 999)],
        foregroundPackage: "fg",
        capacity: 1,
      }),
    ).toEqual(["x", "y"])
  })

  test("capacity 0 evicts everything backgrounded", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 1), entry("b", 2), entry("fg", 999)],
        foregroundPackage: "fg",
        capacity: 0,
      }),
    ).toEqual(["a", "b"])
  })

  test("no foreground app: every entry is eviction-eligible", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 10), entry("b", 20), entry("c", 30)],
        foregroundPackage: null,
        capacity: 2,
      }),
    ).toEqual(["a"])
  })

  test("negative capacity is coerced to 0 (over-cautious eviction)", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 1), entry("b", 2)],
        foregroundPackage: "b",
        capacity: -5,
      }),
    ).toEqual(["a"])
  })

  test("non-integer capacity is floored (capacity 1.9 still means 1 slot)", () => {
    expect(
      selectMiniappsToEvict({
        entries: [entry("a", 1), entry("b", 2), entry("c", 3)],
        foregroundPackage: "c",
        capacity: 1.9,
      }),
    ).toEqual(["a"])
  })
})
