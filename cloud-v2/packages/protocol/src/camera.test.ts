import { describe, expect, test } from "bun:test";

import {
  normalizePhotoCompress,
  normalizePhotoSizeTier,
  photoOptionsSchema,
} from "./camera";

describe("normalizePhotoSizeTier", () => {
  test.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["max", "max"],
    ["small", "low"],
    ["large", "high"],
    ["full", "max"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizePhotoSizeTier(input)).toBe(expected);
  });

  test("rejects unknown values", () => {
    expect(() => normalizePhotoSizeTier("gigantic")).toThrow(/invalid photo size/);
  });
});

describe("photoOptionsSchema", () => {
  test.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["max", "max"],
    ["small", "low"],
    ["large", "high"],
    ["full", "max"],
  ] as const)("accepts size %s and normalizes to %s", (input, expected) => {
    const parsed = photoOptionsSchema.parse({ size: input });
    expect(parsed.size).toBe(expected);
  });

  test("accepts omitted size", () => {
    expect(photoOptionsSchema.parse({})).toEqual({});
  });

  test("rejects invalid size", () => {
    const result = photoOptionsSchema.safeParse({ size: "gigantic" });
    expect(result.success).toBe(false);
  });

  test("normalizes compression aliases", () => {
    expect(photoOptionsSchema.parse({ compress: "low" }).compress).toBe("medium");
    expect(photoOptionsSchema.parse({ compress: "high" }).compress).toBe("heavy");
    expect(photoOptionsSchema.parse({ compress: "none" }).compress).toBe("none");
  });
});

describe("normalizePhotoCompress", () => {
  test.each([
    ["none", "none"],
    ["low", "medium"],
    ["medium", "medium"],
    ["high", "heavy"],
    ["heavy", "heavy"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizePhotoCompress(input)).toBe(expected);
  });
});
