import { describe, expect, test } from "bun:test";
import { applyDefaultCreatePermissions } from "../console.apps.service";

describe("applyDefaultCreatePermissions", () => {
  test("adds MICROPHONE when permissions are omitted", () => {
    const appInput = {
      packageName: "com.example.app",
      name: "Example",
    };

    expect(applyDefaultCreatePermissions(appInput)).toEqual({
      ...appInput,
      permissions: [
        {
          type: "MICROPHONE",
          description: "Access to microphone for voice input and audio processing",
        },
      ],
    });
  });

  test("preserves explicit empty permissions", () => {
    const appInput = {
      packageName: "com.example.app",
      permissions: [],
    };

    expect(applyDefaultCreatePermissions(appInput)).toEqual(appInput);
  });

  test("preserves explicit permissions", () => {
    const appInput = {
      packageName: "com.example.app",
      permissions: [{ type: "LOCATION" }],
    };

    expect(applyDefaultCreatePermissions(appInput)).toEqual(appInput);
  });
});
