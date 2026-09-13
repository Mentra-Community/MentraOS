import { z } from "zod";
import { apiRequest } from "@/api/http";

export const developerOrgSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  workosOrgId: z.string().nullable(),
  name: z.string(),
  packagePrefix: z.string(),
  packagePrefixStatus: z.enum(["unverified", "verified", "rejected"]),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type DeveloperOrg = z.infer<typeof developerOrgSchema>;

export function getDeveloperOrg(): Promise<{ org: DeveloperOrg | null }> {
  return apiRequest("/console/org", z.object({ org: developerOrgSchema.nullable() }));
}

export function saveDeveloperOrg(input: {
  displayName: string;
  packagePrefix: string;
  createNew?: boolean;
}): Promise<{ org: DeveloperOrg }> {
  return apiRequest("/console/org", z.object({ org: developerOrgSchema }), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export const orgRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const orgMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: orgRoleSchema,
  status: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const orgInvitationStateSchema = z.enum(["pending", "accepted", "revoked"]);
export const orgInvitationRoleSchema = z.enum(["admin", "member"]);

export const orgInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  state: orgInvitationStateSchema,
  role: orgInvitationRoleSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type OrgMember = z.infer<typeof orgMemberSchema>;
export type OrgInvitation = z.infer<typeof orgInvitationSchema>;

export function getOrgAccess(): Promise<{
  org: DeveloperOrg;
  viewerRole: OrgRole;
  members: OrgMember[];
  invitations: OrgInvitation[];
}> {
  return apiRequest(
    "/console/org/access",
    z.object({
      org: developerOrgSchema,
      viewerRole: orgRoleSchema,
      members: z.array(orgMemberSchema),
      invitations: z.array(orgInvitationSchema),
    }),
  );
}

export function inviteOrgMember(
  input: { email: string },
): Promise<{ invitation: OrgInvitation; inviteUrl: string }> {
  return apiRequest(
    "/console/org/invitations",
    z.object({ invitation: orgInvitationSchema, inviteUrl: z.string() }),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function acceptOrgInvitation(token: string): Promise<{ ok: boolean; org: DeveloperOrg | null }> {
  return apiRequest(
    "/console/org/invitations/accept",
    z.object({ ok: z.boolean(), org: developerOrgSchema.nullable() }),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    },
  );
}

export function updateOrgMemberRole(input: {
  membershipId: string;
  role: "owner" | "admin" | "member";
}): Promise<{ ok: boolean; role: string }> {
  return apiRequest(
    "/console/org/members/" + encodeURIComponent(input.membershipId),
    z.object({ ok: z.boolean(), role: z.string() }),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: input.role }),
    },
  );
}

export function revokeOrgInvitation(invitationId: string): Promise<{ ok: boolean }> {
  return apiRequest("/console/org/invitations/" + encodeURIComponent(invitationId), z.object({ ok: z.boolean() }), {
    method: "DELETE",
  });
}

export function removeOrgMember(membershipId: string): Promise<{ ok: boolean }> {
  return apiRequest("/console/org/members/" + encodeURIComponent(membershipId), z.object({ ok: z.boolean() }), {
    method: "DELETE",
  });
}
