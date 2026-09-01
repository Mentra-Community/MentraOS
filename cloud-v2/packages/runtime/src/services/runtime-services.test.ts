import { describe, expect, test } from "bun:test";
import { resolveRuntimeServices, serviceList } from "./runtime-services";

describe("Runtime service composition", () => {
  test("resolves the restricted enterprise profile", () => {
    expect(serviceList(resolveRuntimeServices("meetings"))).toEqual([
      "meetings",
    ]);
  });

  test("rejects unknown modules instead of inferring behavior", () => {
    expect(() => resolveRuntimeServices("meetings,speech-maybe")).toThrow(
      "unknown services: speech-maybe",
    );
  });

  test("keeps the existing full profile when the variable is absent", () => {
    expect(serviceList(resolveRuntimeServices(undefined))).toEqual([
      "realtime-audio",
      "managed-photos",
      "maps",
      "tts",
    ]);
  });
});
