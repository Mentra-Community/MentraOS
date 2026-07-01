import { displayNameForUser, type ConsoleUser } from "@/features/session/session.api";

/**
 * Sensible org defaults derived from the signed-in user's email, used to
 * pre-fill the create-org form (both the onboarding gate and the org settings
 * page). Mentra staff get the reserved `com.mentra` prefix; everyone else gets a
 * `dev.<local-part>` namespace they can edit.
 */
export function suggestedOrgDefaults(user: ConsoleUser | undefined) {
  const email = user?.email?.toLowerCase() ?? "";
  const name = displayNameForUser(user);
  if (email.endsWith("@mentraglass.com")) {
    return { displayName: "Mentra Developers", packagePrefix: "com.mentra" };
  }

  // Build a `dev.<local>` prefix that always satisfies isValidPackagePrefix:
  // split the email local-part on invalid chars, then drop any leading
  // non-letters from each segment so every segment starts with a letter
  // (reverse-DNS segments beginning with a digit or underscore are rejected).
  const localSegments = (email.split("@")[0] ?? "")
    .split(/[^a-z0-9_]+/)
    .map(segment => segment.replace(/^[^a-z]+/, ""))
    .filter(Boolean);
  const local = localSegments.join(".") || "developer";
  return {
    displayName: `${name} Team`,
    packagePrefix: `dev.${local}`,
  };
}

export function normalizePackagePrefix(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Lowercase reverse-DNS prefix: two or more dot-separated segments, each
 * starting with a letter and containing only lowercase letters, digits, or
 * underscores (e.g. `io.acme`, `dev.jane_doe`). Rejects leading/trailing/repeated
 * dots and other invalid characters that the UI otherwise lets through.
 */
export function isValidPackagePrefix(value: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value);
}
