/**
 * What the Mentra App's Fleet sheets and the Settings workspace page need from Core and Fleet.
 *
 * The cloud-client package provides the real calls (`/api/client/workspaces/*` and Fleet's desired state). The
 * sheets are written against this small interface so they can be built and tested without it. Wire the real
 * implementation once with `setWorkspaceApi`; until then every call throws "not wired", and the sheets treat
 * that as "nothing to show".
 *
 * Failures of an expected kind must reject with an error whose `code` is Core's error code (for example
 * `last_owner`, `invitation_expired`). Nothing in here shows an error's text to the person.
 */
import type {InvitationPreview, MyWorkspace} from "@mentra/workspace-contract"

export type {InvitationPreview, MyWorkspace}

export interface WorkspaceApi {
  /** `GET /api/client/workspaces/mine`: the person's workspace, or null when they are in none. */
  mine(): Promise<MyWorkspace | null>
  /** `GET /api/client/workspaces/invitations/mine`: invitations addressed to the person that they can accept. */
  invitations(): Promise<InvitationPreview[]>
  /** `POST .../invitations/:invitationId/accept`: join the workspace. Rejects `already_in_workspace`, `invitation_expired`. */
  accept(invitationId: string): Promise<MyWorkspace>
  /** `POST .../invitations/:invitationId/decline`: turn the invitation down (idempotent). */
  decline(invitationId: string): Promise<void>
  /**
   * `POST /api/client/workspaces/leave`, naming the stored workspace. Rejects `last_owner` for the workspace's only
   * Owner, and `membership_changed` when the person is no longer in the stored workspace.
   */
  leave(): Promise<void>
  /**
   * Fetch Fleet's desired state now, without waiting for a revision ack, and apply it. It is called straight
   * after a join and after a leave, so the phone is managed (or unmanaged) at once. Must not throw for a
   * failed fetch: the phone keeps its last complete snapshot and the next ack catches up.
   */
  refreshDesiredState(): Promise<void>
}

const notWired = (member: string) => (): never => {
  throw new Error(`WorkspaceApi.${member}: not wired`)
}

/** The default: every call throws, because nothing has wired the real client yet. */
const unwiredWorkspaceApi: WorkspaceApi = {
  mine: notWired("mine"),
  invitations: notWired("invitations"),
  accept: notWired("accept"),
  decline: notWired("decline"),
  leave: notWired("leave"),
  refreshDesiredState: notWired("refreshDesiredState"),
}

let current: WorkspaceApi = unwiredWorkspaceApi

/** The workspace calls in use. */
export const getWorkspaceApi = (): WorkspaceApi => current

/** Wires the real calls (or a fake in tests). Pass null to go back to the unwired default. */
export function setWorkspaceApi(api: WorkspaceApi | null): void {
  current = api ?? unwiredWorkspaceApi
}

/** Core's error code carried by a failed call, if it carries one. */
export function workspaceErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as {code?: unknown}).code
  return typeof code === "string" ? code : undefined
}

/** Core's error codes the sheets give their own words. The values are `CLIENT_WORKSPACE_ERRORS` in the contract. */
export const WORKSPACE_ERROR = {
  lastOwner: "last_owner",
  invitationExpired: "invitation_expired",
  invitationNotFound: "invitation_not_found",
  alreadyInWorkspace: "already_in_workspace",
} as const
