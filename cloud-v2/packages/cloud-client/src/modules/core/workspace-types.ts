/**
 * @fileoverview The wire shapes of Core's `/api/client/workspaces` router, as the Mentra App reads them.
 *
 * `@mentra/workspace-contract` defines them for Core, but it is a private package and this one is published, so a
 * consumer of `@mentra/cloud-client` could not resolve an import of it. They are restated here instead;
 * `workspace-types.test.ts` holds each one equal to the contract's, so the two cannot drift apart.
 */

/** A role in a workspace (`WorkspaceRole` in the contract). */
export type ClientWorkspaceRole = "member" | "developer" | "admin" | "owner";

/** An invitation as the invitee sees it before accepting. It never carries the token or its hash. */
export interface InvitationPreview {
  invitationId: string;
  workspaceId: string;
  workspaceName: string;
  /** The invited address. */
  email: string;
  role: ClientWorkspaceRole;
  /** Who sent it, by email address; null when the system did, or the address is no longer known. */
  invitedByEmail: string | null;
  expiresAt: string;
}

/** The workspace the signed-in phone's person belongs to (`GET /api/client/workspaces/mine`). */
export interface MyWorkspace {
  workspaceId: string;
  name: string;
  role: ClientWorkspaceRole;
  membershipId: string;
}

/** `GET /api/client/workspaces/mine`. */
export interface MyWorkspaceResponse {
  workspace: MyWorkspace | null;
}

/** `GET /api/client/workspaces/invitations/mine`: the invitations addressed to the signed-in person. */
export interface PendingInvitationsResponse {
  invitations: InvitationPreview[];
}

/** `POST /api/client/workspaces/invitations/:invitationId/accept`. */
export interface AcceptInvitationResult {
  workspace: MyWorkspace;
}

/** `POST /api/client/workspaces/invitations/:invitationId/decline`. Declining twice is idempotent. */
export interface DeclineInvitationResult {
  invitationId: string;
  declined: true;
}

/**
 * `POST /api/client/workspaces/leave`. With `workspaceId`, Core leaves that workspace only while the person is in
 * it, and answers `membership_changed` (409) otherwise; without one, the person's workspace.
 */
export interface LeaveWorkspaceRequest {
  workspaceId?: string;
}
