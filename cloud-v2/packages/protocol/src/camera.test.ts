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

  test("accepts the phone-side flags", () => {
    const parsed = photoOptionsSchema.parse({
      saveToGallery: true,
      saveToCameraRoll: true,
      sound: false,
    });
    expect(parsed.saveToGallery).toBe(true);
    expect(parsed.saveToCameraRoll).toBe(true);
    expect(parsed.sound).toBe(false);
  });

  test("rejects a non-boolean saveToCameraRoll", () => {
    expect(photoOptionsSchema.safeParse({ saveToCameraRoll: "yes" }).success).toBe(false);
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
