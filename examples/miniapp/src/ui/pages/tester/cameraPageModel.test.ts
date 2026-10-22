import {describe, expect, test} from "bun:test"

import {
  buildTakePhotoArgs,
  buildWarmUpArgs,
  CANONICAL_PHOTO_SIZES,
  DEFAULT_WARMUP_DURATION_MS,
  formatByteSize,
  formatElapsedMs,
  wirePhotoSize,
} from "./cameraPageModel"

describe("cameraPageModel", () => {
  test("text mode sends mode without forcing a public max quality tier", () => {
    expect(
      buildTakePhotoArgs({
        size: "high",
        mode: "text",
        zsl: false,
        mfnr: false,
      }),
    ).toEqual([
      {
        size: "medium",
        mode: "text",
        zsl: false,
        mfnr: false,
      },
    ])
  })

  test("buildTakePhotoArgs always includes explicit zsl and mfnr", () => {
    expect(buildTakePhotoArgs({size: "medium", mode: "photo", zsl: true, mfnr: true})).toEqual([
      {size: "medium", mode: "photo", zsl: true, mfnr: true},
    ])
    expect(buildTakePhotoArgs({size: "medium", mode: "photo", zsl: false, mfnr: false})).toEqual([
      {size: "medium", mode: "photo", zsl: false, mfnr: false},
    ])
  })

  test("photo mode preserves its selected quality", () => {
    expect(wirePhotoSize("high", "photo")).toBe("high")
    expect(buildTakePhotoArgs({size: "low", mode: "photo", zsl: false, mfnr: false})).toEqual([
      {size: "low", mode: "photo", zsl: false, mfnr: false},
    ])
  })

  test("warm-up carries mode so ASG can apply text sensor constants", () => {
    expect(buildWarmUpArgs("low", "photo")).toEqual([
      {size: "low", mode: "photo", durationMs: DEFAULT_WARMUP_DURATION_MS},
    ])
    expect(buildWarmUpArgs("high", "text", 20_000)).toEqual([
      {size: "medium", mode: "text", durationMs: 20_000},
    ])
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
