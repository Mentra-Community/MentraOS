import {
  galleryVideoReportDedupeKey,
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

describe("galleryVideoReportDedupeKey", () => {
  it("is stable for same inputs", () => {
    const p = serializeReactNativeVideoOnError({error: {code: 1, domain: "D"}})
    expect(galleryVideoReportDedupeKey("IMG_1", p)).toBe("IMG_1|D|1")
  })
})
