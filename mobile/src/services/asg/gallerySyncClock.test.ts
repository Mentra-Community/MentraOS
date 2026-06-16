import {CLOCK_SKEW_TOLERANCE_MS, detectClockSkew, isSyncManifestEmpty} from "./gallerySyncClock"

describe("gallerySyncClock", () => {
  const phoneNow = 1_700_000_000_000
  const glassesTime = phoneNow

  describe("detectClockSkew", () => {
    it("detects watermark ahead of glasses server time", () => {
      const lastSyncTime = glassesTime + CLOCK_SKEW_TOLERANCE_MS + 1
      expect(detectClockSkew(phoneNow, glassesTime, lastSyncTime)).toEqual({
        skewed: true,
        reason: "watermark_ahead_of_glasses",
      })
    })

    it("detects wall clock drift between phone and glasses", () => {
      const driftedGlassesTime = phoneNow - CLOCK_SKEW_TOLERANCE_MS - 1
      expect(detectClockSkew(phoneNow, driftedGlassesTime, 0)).toEqual({
        skewed: true,
        reason: "wall_clock_drift",
      })
    })

    it("reports no skew when clocks and watermark align", () => {
      expect(detectClockSkew(phoneNow, glassesTime, glassesTime - 1000)).toEqual({
        skewed: false,
        reason: "",
      })
    })
  })

  describe("isSyncManifestEmpty", () => {
    it("returns true when legacy changed_files is empty", () => {
      expect(isSyncManifestEmpty({changed_files: []})).toBe(true)
    })

    it("returns false when captures are present (api v2)", () => {
      expect(
        isSyncManifestEmpty({
          api_version: 2,
          captures: [{capture_id: "IMG_1"}],
          changed_files: [],
        }),
      ).toBe(false)
    })
  })
})
