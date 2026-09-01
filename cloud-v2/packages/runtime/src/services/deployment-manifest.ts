import type { RuntimeServiceName } from "./runtime-services";

const MAX_MANIFEST_BYTES = 256 * 1024;

interface RuntimeDeploymentManifest {
  schemaVersion: 1;
  features: {
    runtimeRealtimeSession: boolean;
    managedStreams: boolean;
    nativeMeetings: boolean;
    cloudSpeech: boolean;
    navigation: boolean;
  };
}

export function parseDeploymentManifest(body: string): {
  body: string;
  manifest: RuntimeDeploymentManifest;
} {
  if (Buffer.byteLength(body, "utf8") > MAX_MANIFEST_BYTES)
    throw new Error("deployment manifest exceeds 256 KiB");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("deployment manifest is not valid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error("deployment manifest must use schemaVersion 1");
  }
  const features = (parsed as { features?: unknown }).features;
  if (!features || typeof features !== "object")
    throw new Error("deployment manifest must declare features");
  for (const name of [
    "runtimeRealtimeSession",
    "managedStreams",
    "nativeMeetings",
    "cloudSpeech",
    "navigation",
  ] as const) {
    if (typeof (features as Record<string, unknown>)[name] !== "boolean")
      throw new Error(`deployment manifest feature ${name} must be boolean`);
  }

  return {
    body: `${JSON.stringify(parsed)}\n`,
    manifest: parsed as RuntimeDeploymentManifest,
  };
}

/** Fail boot when the customer-visible capability contract and mounted routes disagree. */
export function assertManifestMatchesRuntimeServices(
  manifest: RuntimeDeploymentManifest,
  services: ReadonlySet<RuntimeServiceName>,
): void {
  const advertised = manifest.features;
  const actual = {
    runtimeRealtimeSession: services.has("realtime-audio"),
    managedStreams: services.has("managed-photos"),
    nativeMeetings: services.has("meetings"),
    cloudSpeech: services.has("realtime-audio") || services.has("tts"),
    navigation: services.has("maps"),
  };
  const mismatches = (Object.keys(actual) as Array<keyof typeof actual>).filter(
    (name) => advertised[name] !== actual[name],
  );
  if (mismatches.length > 0) {
    throw new Error(
      `deployment manifest features do not match RUNTIME_SERVICES: ${mismatches.join(", ")}`,
    );
  }
}
