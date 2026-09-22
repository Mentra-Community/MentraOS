import {describe, expect, test} from "bun:test";

import {resolveMeetingProviders} from "./meeting-providers";

describe("Runtime meeting providers", () => {
  test("selects the ACS Teams implementation explicitly", () => {
    expect([...resolveMeetingProviders("acs-teams")]).toEqual(["acs-teams"]);
  });

  test("rejects missing and unknown providers", () => {
    expect(() => resolveMeetingProviders("")).toThrow("MEETING_PROVIDERS");
    expect(() => resolveMeetingProviders("zoom")).toThrow(
      "unknown providers: zoom",
    );
  });
});
