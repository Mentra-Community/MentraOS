export const RUNTIME_SERVICE_NAMES = [
  "realtime-audio",
  "camera",
  "maps",
  "tts",
  "meetings",
] as const;

export type RuntimeServiceName = (typeof RUNTIME_SERVICE_NAMES)[number];

const FULL_RUNTIME_SERVICES = new Set<RuntimeServiceName>([
  "realtime-audio",
  "camera",
  "maps",
  "tts",
]);

export function resolveRuntimeServices(
  value = process.env.RUNTIME_SERVICES,
): Set<RuntimeServiceName> {
  if (!value?.trim() || value.trim() === "full")
    return new Set(FULL_RUNTIME_SERVICES);

  const requested = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (requested.length === 0)
    throw new Error("RUNTIME_SERVICES must enable at least one service");

  const known = new Set<string>(RUNTIME_SERVICE_NAMES);
  const unknown = requested.filter((entry) => !known.has(entry));
  if (unknown.length > 0) {
    throw new Error(
      `RUNTIME_SERVICES contains unknown services: ${unknown.join(", ")}`,
    );
  }
  return new Set(requested as RuntimeServiceName[]);
}

export function serviceList(
  services: ReadonlySet<RuntimeServiceName>,
): RuntimeServiceName[] {
  return RUNTIME_SERVICE_NAMES.filter((service) => services.has(service));
}
