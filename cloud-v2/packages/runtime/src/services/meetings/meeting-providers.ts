export const MEETING_PROVIDER_NAMES = ["acs-teams"] as const;

export type MeetingProviderName = (typeof MEETING_PROVIDER_NAMES)[number];

export function resolveMeetingProviders(
  value = process.env.MEETING_PROVIDERS,
): Set<MeetingProviderName> {
  const requested = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error(
      "meetings service requires at least one MEETING_PROVIDERS value",
    );
  }

  const known = new Set<string>(MEETING_PROVIDER_NAMES);
  const unknown = requested.filter((entry) => !known.has(entry));
  if (unknown.length > 0) {
    throw new Error(
      `MEETING_PROVIDERS contains unknown providers: ${unknown.join(", ")}`,
    );
  }
  return new Set(requested as MeetingProviderName[]);
}
