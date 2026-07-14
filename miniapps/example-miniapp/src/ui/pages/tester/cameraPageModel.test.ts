import {describe, expect, test} from "bun:test"

import {
  buildTakePhotoArgs,
  buildWarmUpArgs,
  CANONICAL_PHOTO_SIZES,
  createCaptureHistoryEntry,
  DEFAULT_WARMUP_DURATION_MS,
  formatByteSize,
  formatElapsedMs,
} from "./cameraPageModel"

describe("cameraPageModel", () => {
  test("buildTakePhotoArgs forwards the full takePhoto contract", () => {
    expect(
      buildTakePhotoArgs({
        size: "high",
        mode: "text",
        compress: "medium",
        sound: false,
        saveToGallery: true,
        exposureTimeNs: 12_000_000,
      }),
    ).toEqual([
      {
        size: "high",
        mode: "text",
        compress: "medium",
        sound: false,
        saveToGallery: true,
        exposureTimeNs: 12_000_000,
      },
    ])
  })

  test("buildTakePhotoArgs omits exposureTimeNs when unset", () => {
    expect(
      buildTakePhotoArgs({
        size: "medium",
        mode: "photo",
        compress: "none",
        sound: true,
        saveToGallery: false,
      }),
    ).toEqual([
      {
        size: "medium",
        mode: "photo",
        compress: "none",
        sound: true,
        saveToGallery: false,
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

  test("createCaptureHistoryEntry records failures", () => {
    expect(
      createCaptureHistoryEntry(
        "size:low",
        {
          size: "low",
          mode: "photo",
          compress: "none",
          sound: true,
          saveToGallery: false,
        },
        100,
        250,
        undefined,
        "camera_busy",
      ),
    ).toEqual({
      id: "100-size:low",
      label: "size:low",
      startedAt: 100,
      elapsedMs: 250,
      options: {
        size: "low",
        mode: "photo",
        compress: "none",
        sound: true,
        saveToGallery: false,
      },
      error: "camera_busy",
    })
  })
})
