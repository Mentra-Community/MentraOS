import {
  GALLERY_VIDEO_REPORT_DEDUPE_MS,
  galleryVideoIncidentDedupeKey,
  galleryVideoReportDedupeShouldSkip,
  serializeReactNativeVideoOnError,
} from "./galleryVideoPlaybackBugReportCore"

describe("serializeReactNativeVideoOnError", () => {
  it("extracts iOS AVFoundation fields", () => {
    const parsed = serializeReactNativeVideoOnError({
      error: {
        domain: "AVFoundationErrorDomain",
        code: -11829,
        localizedDescription: "Cannot Open",
      },
    })
    expect(parsed.domain).toBe("AVFoundationErrorDomain")
    expect(parsed.code).toBe(-11829)
    expect(parsed.localizedDescription).toBe("Cannot Open")
    expect(parsed.raw).toContain("AVFoundationErrorDomain")
  })

  it("handles unknown payload", () => {
    const parsed = serializeReactNativeVideoOnError(null)
    expect(parsed.raw).toBe("null")
  })
})

describe("galleryVideoIncidentDedupeKey", () => {
  it("is stable for same inputs", () => {
    const p = serializeReactNativeVideoOnError({error: {code: 1, domain: "D"}})
    expect(galleryVideoIncidentDedupeKey("IMG_1", p)).toBe("IMG_1|D|1")
  })
})

describe("galleryVideoReportDedupeShouldSkip", () => {
  it("allows first report and skips second within window", () => {
    const reg = new Map<string, number>()
    const t0 = 1_000_000
    expect(galleryVideoReportDedupeShouldSkip("k", t0, GALLERY_VIDEO_REPORT_DEDUPE_MS, reg)).toBe(false)
    expect(galleryVideoReportDedupeShouldSkip("k", t0 + 1000, GALLERY_VIDEO_REPORT_DEDUPE_MS, reg)).toBe(true)
  })

  it("allows again after window", () => {
    const reg = new Map<string, number>()
    const t0 = 1_000_000
    expect(galleryVideoReportDedupeShouldSkip("k", t0, 10_000, reg)).toBe(false)
    expect(galleryVideoReportDedupeShouldSkip("k", t0 + 11_000, 10_000, reg)).toBe(false)
  })
})
