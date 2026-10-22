/**
 * The real `WorkspaceApi`: Core's `/api/client/workspaces` through the engine's cloud client, and Fleet's desired
 * state through the assignment reconciler.
 *
 * Each call is made as the account signed in when it starts, and an answer that arrives after another account
 * signed in is dropped (`session_changed`), so one account's workspace never lands in another's screens. A sign-in
 * as someone else, or a sign-out, also forgets the stored workspace.
 */
import {cloudClientService, notifyFleetWorkspaceLeft, triggerAssignmentReconcile} from "@mentra/engine-host-internal"

import {useMyWorkspaceStore} from "./myWorkspace"
import {notifyWorkspaceApiReady, setWorkspaceApi, type WorkspaceApi} from "./workspaceApi"

/** Codes for failures Core did not name. Core's own codes pass through as they are. */
export const WORKSPACE_CLIENT_ERROR = {
  sessionChanged: "session_changed",
  invalidResponse: "invalid_response",
  authExpired: "auth_expired",
  unknown: "unknown",
} as const

/** A failed workspace call. `code` is Core's error code when Core gave one (`network_error` when nothing answered). */
export class WorkspaceApiError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, options?: {status?: number; cause?: unknown}) {
    super(`Workspace call failed (${code})`)
    this.name = "WorkspaceApiError"
    this.code = code
    this.status = options?.status
    this.cause = options?.cause
  }
}

/** Maps a cloud-client failure to a `WorkspaceApiError`. Matched by name: the classes may come from another copy. */
export function toWorkspaceApiError(error: unknown): WorkspaceApiError {
  if (error instanceof WorkspaceApiError) return error
  const failure =
    typeof error === "object" && error !== null ? (error as {name?: unknown; code?: unknown; status?: unknown}) : {}
  const status = typeof failure.status === "number" ? failure.status : undefined
  switch (failure.name) {
    case "CoreRequestError":
      return new WorkspaceApiError(typeof failure.code === "string" ? failure.code : WORKSPACE_CLIENT_ERROR.unknown, {
        status,
        cause: error,
      })
    case "SessionChangedError":
      return new WorkspaceApiError(WORKSPACE_CLIENT_ERROR.sessionChanged, {cause: error})
    case "CoreResponseError":
      return new WorkspaceApiError(WORKSPACE_CLIENT_ERROR.invalidResponse, {cause: error})
    case "AuthExpiredError":
      return new WorkspaceApiError(WORKSPACE_CLIENT_ERROR.authExpired, {cause: error})
    default:
      return new WorkspaceApiError(WORKSPACE_CLIENT_ERROR.unknown, {status, cause: error})
  }
}

const signedInAccount = (): string | null => cloudClientService.getCoreSession()?.mentraUserId ?? null

async function asSignedInAccount<T>(call: (opts: {expectedAccount?: string}) => Promise<T>): Promise<T> {
  const account = signedInAccount()
  let value: T
  try {
    value = await call(account ? {expectedAccount: account} : {})
  } catch (error) {
    throw toWorkspaceApiError(error)
  }
  if (signedInAccount() !== account) throw new WorkspaceApiError(WORKSPACE_CLIENT_ERROR.sessionChanged)
  return value
}

export const cloudWorkspaceApi: WorkspaceApi = {
  async mine() {
    return (await asSignedInAccount((opts) => cloudClientService.core.workspaces.mine(opts))).workspace
  },
  async invitations() {
    return (await asSignedInAccount((opts) => cloudClientService.core.workspaces.pendingInvitations(opts))).invitations
  },
  async accept(invitationId) {
    const result = await asSignedInAccount((opts) =>
      cloudClientService.core.workspaces.acceptInvitation(invitationId, opts),
    )
    return result.workspace
  },
  async decline(invitationId) {
    await asSignedInAccount((opts) => cloudClientService.core.workspaces.declineInvitation(invitationId, opts))
  },
  async leave() {
    await asSignedInAccount((opts) => cloudClientService.core.workspaces.leave(opts))
    try {
      notifyFleetWorkspaceLeft()
    } catch (error) {
      console.warn("Fleet: could not tell the reconciler about the leave", error)
    }
  },
  async refreshDesiredState() {
    triggerAssignmentReconcile()
  },
}

let installed: (() => void) | null = null

/**
 * Wires `cloudWorkspaceApi` for the Fleet sheets and the Settings workspace page, and forgets the stored workspace
 * when the signed-in account changes. Idempotent; returns the uninstall.
 */
export function installCloudWorkspaceApi(): () => void {
  if (installed) return installed
  setWorkspaceApi(cloudWorkspaceApi)
  let account = signedInAccount()
  const unsubscribe = cloudClientService.onCoreSessionChanged((change) => {
    if (change.reason === "reconnect" && (change.mentraUserId === account || change.mentraUserId === null)) return
    const otherAccount = change.mentraUserId !== account
    if (otherAccount || change.reason === "signed_out") useMyWorkspaceStore.getState().reset()
    account = change.mentraUserId
    if (otherAccount && account) notifyWorkspaceApiReady()
  })
  installed = () => {
    unsubscribe()
    setWorkspaceApi(null)
    installed = null
  }
  return installed
}
