/**
 * @fileoverview `cloud.core.workspaces`: the Mentra App's own view of the workspace the signed-in person belongs to,
 * over Core's `/api/client/workspaces` router.
 *
 *   GET  /mine                               the person's workspace, or `{workspace: null}`
 *   GET  /invitations/mine                   invitations addressed to their verified email
 *   POST /invitations/:invitationId/accept   join the workspace the invitation is for
 *   POST /invitations/:invitationId/decline  turn it down (idempotent)
 *   POST /leave                              leave the workspace (204; the only Owner cannot)
 *
 * Each call is made as the account whose Core token it carries (see `account-call.ts`): an answer that comes back after
 * the account changed is discarded as `SessionChangedError`, and a 401 refreshes the token once. A failure keeps
 * Core's status and error code on a `CoreRequestError` (`already_in_workspace`, `last_owner`, `invitation_expired`,
 * `invitation_not_found`, `email_unverified`, `membership_changed`, ...) and never carries Core's wording.
 */
import type {
  AcceptInvitationResult,
  DeclineInvitationResult,
  InvitationPreview,
  LeaveWorkspaceRequest,
  MyWorkspace,
  MyWorkspaceResponse,
  PendingInvitationsResponse,
} from "@mentra/workspace-contract"
import type {HttpClient} from "../../http"
import {AccountCaller, CoreResponseError, type AccountCallOptions, type CoreTokenSource} from "./account-call"

const BASE = "/api/client/workspaces"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function readWorkspace(value: unknown): MyWorkspace {
  if (
    !isObject(value) ||
    !isText(value.workspaceId) ||
    typeof value.name !== "string" ||
    !isText(value.role) ||
    !isText(value.membershipId)
  ) {
    throw new CoreResponseError("invalid_shape")
  }
  return {
    workspaceId: value.workspaceId,
    name: value.name,
    role: value.role as MyWorkspace["role"],
    membershipId: value.membershipId,
  }
}

function readInvitation(value: unknown): InvitationPreview {
  if (
    !isObject(value) ||
    !isText(value.invitationId) ||
    !isText(value.workspaceId) ||
    typeof value.workspaceName !== "string" ||
    typeof value.email !== "string" ||
    !isText(value.role) ||
    (value.invitedByEmail !== null && typeof value.invitedByEmail !== "string") ||
    !isText(value.expiresAt)
  ) {
    throw new CoreResponseError("invalid_shape")
  }
  return {
    invitationId: value.invitationId,
    workspaceId: value.workspaceId,
    workspaceName: value.workspaceName,
    email: value.email,
    role: value.role as InvitationPreview["role"],
    invitedByEmail: value.invitedByEmail,
    expiresAt: value.expiresAt,
  }
}

export class Workspaces {
  private readonly caller: AccountCaller

  constructor(
    private readonly http: HttpClient,
    auth?: CoreTokenSource,
  ) {
    this.caller = new AccountCaller(auth)
  }

  /** The workspace the signed-in person belongs to, or `{workspace: null}`. */
  async mine(opts?: AccountCallOptions): Promise<MyWorkspaceResponse> {
    const body = await this.caller.run(
      bearer => this.http.get<unknown>(`${BASE}/mine`, {bearer, ...(opts?.signal ? {signal: opts.signal} : {})}),
      opts,
    )
    if (!isObject(body) || !("workspace" in body)) throw new CoreResponseError("invalid_shape")
    return {workspace: body.workspace === null ? null : readWorkspace(body.workspace)}
  }

  /** The invitations addressed to the signed-in person's verified email that they can still accept. */
  async pendingInvitations(opts?: AccountCallOptions): Promise<PendingInvitationsResponse> {
    const body = await this.caller.run(
      bearer =>
        this.http.get<unknown>(`${BASE}/invitations/mine`, {bearer, ...(opts?.signal ? {signal: opts.signal} : {})}),
      opts,
    )
    if (!isObject(body) || !Array.isArray(body.invitations)) throw new CoreResponseError("invalid_shape")
    return {invitations: body.invitations.map(readInvitation)}
  }

  /** Joins the workspace the invitation is for. `already_in_workspace` (409) means leave the current one first. */
  async acceptInvitation(invitationId: string, opts?: AccountCallOptions): Promise<AcceptInvitationResult> {
    const body = await this.caller.run(
      bearer =>
        this.http.post<unknown>(`${BASE}/invitations/${encodeURIComponent(invitationId)}/accept`, undefined, {
          bearer,
          ...(opts?.signal ? {signal: opts.signal} : {}),
        }),
      opts,
    )
    if (!isObject(body)) throw new CoreResponseError("invalid_shape")
    return {workspace: readWorkspace(body.workspace)}
  }

  /** Turns the invitation down. Declining twice is fine; no membership changes. */
  async declineInvitation(invitationId: string, opts?: AccountCallOptions): Promise<DeclineInvitationResult> {
    const body = await this.caller.run(
      bearer =>
        this.http.post<unknown>(`${BASE}/invitations/${encodeURIComponent(invitationId)}/decline`, undefined, {
          bearer,
          // Idempotent on Core, so a transient network failure may be retried.
          idempotent: true,
          ...(opts?.signal ? {signal: opts.signal} : {}),
        }),
      opts,
    )
    if (!isObject(body) || !isText(body.invitationId) || body.declined !== true) {
      throw new CoreResponseError("invalid_shape")
    }
    return {invitationId: body.invitationId, declined: true}
  }

  /**
   * Leaves the workspace: `opts.workspaceId` when given, which Core refuses with `membership_changed` (409) once the
   * person is no longer in it. `last_owner` (409) means the only Owner cannot leave; `not_found` that there is none.
   */
  async leave(opts?: AccountCallOptions & LeaveWorkspaceRequest): Promise<void> {
    const body: LeaveWorkspaceRequest | undefined = opts?.workspaceId ? {workspaceId: opts.workspaceId} : undefined
    await this.caller.run(
      bearer => this.http.post<unknown>(`${BASE}/leave`, body, {bearer, ...(opts?.signal ? {signal: opts.signal} : {})}),
      opts,
    )
  }
}
