import { describe, it, expect } from "bun:test";
import { VIDEO_CONFIG_LIMITS, validateVideoConfig, type VideoConfig } from "../rtmp-stream";

/** Must stay in sync with RtmpStreamConfig / WhipStreamConfig on-device clamps. */
const EXPECTED_LIMITS = {
  width: { min: 320, max: 1920, default: 854 },
  height: { min: 240, max: 1080, default: 480 },
  frameRate: { min: 10, max: 60, default: 15 },
  bitrate: { min: 100_000, max: 10_000_000, default: 1_000_000 },
} as const;

describe("VIDEO_CONFIG_LIMITS", () => {
  it("matches ASG RtmpStreamConfig / WhipStreamConfig clamps (drift guard)", () => {
    expect(VIDEO_CONFIG_LIMITS).toEqual(EXPECTED_LIMITS);
  });
});

describe("validateVideoConfig", () => {
  it("accepts undefined and empty object", () => {
    expect(() => validateVideoConfig(undefined)).not.toThrow();
    expect(() => validateVideoConfig({})).not.toThrow();
  });

  it("accepts combined valid video config", () => {
    expect(() =>
      validateVideoConfig({
        width: 1920,
        height: 1080,
        frameRate: 30,
        bitrate: 4_000_000,
      }),
    ).not.toThrow();
  });

  const keys = ["width", "height", "frameRate", "bitrate"] as const;

  for (const key of keys) {
    const spec = EXPECTED_LIMITS[key];

    it(`${key}: min and max boundary pass`, () => {
      expect(() => validateVideoConfig({ [key]: spec.min } as VideoConfig)).not.toThrow();
      expect(() => validateVideoConfig({ [key]: spec.max } as VideoConfig)).not.toThrow();
    });

    it(`${key}: below min throws RangeError`, () => {
      expect(() => validateVideoConfig({ [key]: spec.min - 1 } as VideoConfig)).toThrow(RangeError);
      try {
        validateVideoConfig({ [key]: spec.min - 1 } as VideoConfig);
      } catch (e: any) {
        expect(String(e.message)).toContain(`video.${key}`);
        expect(String(e.message)).toContain(String(spec.min));
      }
    });

    it(`${key}: above max throws RangeError`, () => {
      expect(() => validateVideoConfig({ [key]: spec.max + 1 } as VideoConfig)).toThrow(RangeError);
    });

    it(`${key}: NaN and non-finite throw`, () => {
      expect(() => validateVideoConfig({ [key]: NaN } as VideoConfig)).toThrow(RangeError);
      expect(() => validateVideoConfig({ [key]: Infinity } as VideoConfig)).toThrow(RangeError);
      expect(() => validateVideoConfig({ [key]: -Infinity } as VideoConfig)).toThrow(RangeError);
    });

    it(`${key}: non-integer throws RangeError`, () => {
      expect(() => validateVideoConfig({ [key]: 100.5 } as VideoConfig)).toThrow(RangeError);
    });
  }

  it("validates fields in declaration order (width before height)", () => {
    expect(() =>
      validateVideoConfig({
        width: 100,
        height: 1080,
      } as VideoConfig),
    ).toThrow(RangeError);
    try {
      validateVideoConfig({ width: 100, height: 1080 } as VideoConfig);
    } catch (e: any) {
      expect(e.message).toContain("video.width");
    }
  });
});
