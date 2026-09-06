import { describe, expect, test } from "bun:test";

import {
  assertManifestMatchesRuntimeServices,
  parseDeploymentManifest,
} from "./deployment-manifest";

function manifest(features: Record<string, boolean>) {
  return JSON.stringify({ schemaVersion: 1, features });
}

describe("Runtime deployment manifest", () => {
  test("accepts a capability contract matching the enabled service profile", () => {
    const parsed = parseDeploymentManifest(
      manifest({
        runtimeRealtimeSession: false,
        managedStreams: false,
        nativeMeetings: true,
        cloudSpeech: false,
        navigation: false,
      }),
    );

    expect(() =>
      assertManifestMatchesRuntimeServices(
        parsed.manifest,
        new Set(["meetings"]),
      ),
    ).not.toThrow();
  });

  test("rejects routes that contradict the advertised capabilities", () => {
    const parsed = parseDeploymentManifest(
      manifest({
        runtimeRealtimeSession: false,
        managedStreams: false,
        nativeMeetings: true,
        cloudSpeech: false,
        navigation: false,
      }),
    );

    expect(() =>
      assertManifestMatchesRuntimeServices(
        parsed.manifest,
        new Set(["camera", "meetings"]),
      ),
    ).toThrow("managedStreams");
  });
});
