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

  const local = email.split("@")[0]?.replace(/[^a-z0-9_]+/g, ".").replace(/^\.+|\.+$/g, "") || "developer";
  return {
    displayName: `${name} Team`,
    packagePrefix: `dev.${local}`,
  };
}

export function normalizePackagePrefix(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}
