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
   * `POST /api/client/workspaces/leave`, naming `workspaceId` (the workspace the person confirmed leaving), else the
   * stored workspace. Rejects `last_owner` for the workspace's only Owner, and `membership_changed` when the person is
   * no longer in the named workspace, so a confirm that went stale never leaves another workspace.
   */
  leave(workspaceId?: string): Promise<void>
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
const readyListeners = new Set<() => void>()

/** The workspace calls in use. */
export const getWorkspaceApi = (): WorkspaceApi => current

/**
 * Calls `listener` each time real calls are wired, and each time they start answering for another account. The
 * sheets mount at sign-in, before the app wires the client or binds the new account's Core session, so their
 * first look finds nothing or is dropped as `session_changed`; this lets them look again. Returns the unsubscribe.
 */
export function onWorkspaceApiReady(listener: () => void): () => void {
  readyListeners.add(listener)
  return () => {
    readyListeners.delete(listener)
  }
}

/** Tells `onWorkspaceApiReady` listeners the calls can answer for the signed-in account now. */
export function notifyWorkspaceApiReady(): void {
  for (const listener of [...readyListeners]) {
    try {
      listener()
    } catch (error) {
      console.warn("Fleet: a workspace API listener failed", error)
    }
  }
}

/** Wires the real calls (or a fake in tests). Pass null to go back to the unwired default. */
export function setWorkspaceApi(api: WorkspaceApi | null): void {
  current = api ?? unwiredWorkspaceApi
  if (api) notifyWorkspaceApiReady()
}

/** Core's error code carried by a failed call, if it carries one. */
export function workspaceErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as {code?: unknown}).code
  return typeof code === "string" ? code : undefined
}

/**
 * The error codes the sheets act on. Core's are `CLIENT_WORKSPACE_ERRORS` in the contract; `sessionChanged` is the
 * real client's (`WORKSPACE_CLIENT_ERROR` in `cloudWorkspaceApi.ts`).
 */
export const WORKSPACE_ERROR = {
  lastOwner: "last_owner",
  invitationExpired: "invitation_expired",
  invitationNotFound: "invitation_not_found",
  alreadyInWorkspace: "already_in_workspace",
  /** The client's own code: the answer came for an account that is no longer signed in. */
  sessionChanged: "session_changed",
} as const
