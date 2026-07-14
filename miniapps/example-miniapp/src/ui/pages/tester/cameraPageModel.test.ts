import {describe, expect, test} from "bun:test"

import {
  buildTakePhotoArgs,
  buildWarmUpArgs,
  CANONICAL_PHOTO_SIZES,
  DEFAULT_WARMUP_DURATION_MS,
  formatByteSize,
  formatElapsedMs,
} from "./cameraPageModel"

describe("cameraPageModel", () => {
  test("buildTakePhotoArgs forwards the example camera options", () => {
    expect(
      buildTakePhotoArgs({
        size: "high",
        mode: "text",
        saveToGallery: true,
      }),
    ).toEqual([
      {
        size: "high",
        mode: "text",
        saveToGallery: true,
      },
    ])
  })

  test("buildWarmUpArgs uses the selected size and default duration", () => {
    expect(buildWarmUpArgs("low")).toEqual([{size: "low", durationMs: DEFAULT_WARMUP_DURATION_MS}])
    expect(buildWarmUpArgs("max", 20_000)).toEqual([{size: "max", durationMs: 20_000}])
  })

  test("size matrix covers canonical sizes", () => {
    expect(CANONICAL_PHOTO_SIZES).toEqual(["low", "medium", "high", "max"])
  })

  test("formatElapsedMs and formatByteSize render readable values", () => {
    expect(formatElapsedMs(1234.6)).toBe("1235 ms")
    expect(formatByteSize(512)).toBe("512 B")
    expect(formatByteSize(2048)).toBe("2.0 KB")
    expect(formatByteSize(-1)).toBe("unknown")
  })

})
