import { z } from "zod";
import { apiRequest } from "@/api/http";

export const consoleSessionSchema = z.object({
  authenticated: z.literal(true),
  user: z.object({
    id: z.string(),
    email: z.string(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
  }),
  onboardingRequired: z.boolean(),
  viewerRole: z.enum(["owner", "admin", "member"]).nullable().optional(),
  organizationId: z.string().nullable().optional(),
  packagePrefix: z.string().nullable(),
  packagePrefixStatus: z.enum(["unverified", "verified", "rejected"]).nullable(),
  organizations: z
    .array(
      z.object({
        id: z.string(),
        ownerUserId: z.string(),
        workosOrgId: z.string().nullable(),
        name: z.string(),
        packagePrefix: z.string(),
        packagePrefixStatus: z.enum(["unverified", "verified", "rejected"]),
        createdAt: z.string().nullable(),
        updatedAt: z.string().nullable(),
      }),
    )
    .optional(),
});

export type ConsoleSession = z.infer<typeof consoleSessionSchema>;
export type ConsoleUser = ConsoleSession["user"];
export type ConsoleOrganization = NonNullable<ConsoleSession["organizations"]>[number];

const logoutResponseSchema = z.object({
  ok: z.boolean(),
  logoutUrl: z.string().nullable(),
});

export function getConsoleSession(): Promise<ConsoleSession> {
  return apiRequest("/console/auth/me", consoleSessionSchema);
}

export function logoutConsoleSession(): Promise<z.infer<typeof logoutResponseSchema>> {
  return apiRequest("/console/auth/logout", logoutResponseSchema, { method: "POST" });
}

export function displayNameForUser(user: ConsoleUser | undefined): string {
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;

  const local = user?.email?.split("@")[0] || "Developer";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(part => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function initialsForUser(user: ConsoleUser | undefined): string {
  const source = displayNameForUser(user) || user?.email?.split("@")[0] || "MD";
  return source
    .split(/[._-]+/)
    .flatMap(part => part.split(/\s+/))
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
