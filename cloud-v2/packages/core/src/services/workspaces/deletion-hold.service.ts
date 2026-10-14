/**
 * @fileoverview Deletion holds: a service's reason a workspace must not be deleted yet.
 *
 * Core does not know what other services keep for a workspace. A service that keeps something the
 * workspace must not lose (the Store, while the workspace owns published miniapps) holds the workspace
 * through the internal API, and `deleteWorkspace` refuses with 409 `workspace_has_holds` while any
 * hold is on it, whoever asks: an Organization Admin clears the cause like everyone else, and the
 * service then clears its hold.
 *
 * Each service has at most one hold per workspace, `{reason, count}`, kept on the workspace document
 * (`deletionHolds`). Setting replaces the service's hold; clearing removes it. Both are idempotent: a
 * call that would change nothing writes nothing and records nothing. A change writes the workspace
 * document inside a transaction, as `deleteWorkspace` does, so the two conflict and serialize: either
 * the hold lands first and the delete is refused, or the delete lands first and the hold is refused
 * (`workspace_deleted`). A deleted workspace therefore never has a hold, and clearing one there is
 * the no-op it looks like.
 *
 * A hold changes nothing anyone may do, so it leaves `authorizationRevision` alone, and nothing but
 * deletion looks at it: renames, memberships, invitations and keys work as before. Deleting an account
 * never deletes a workspace (it ends memberships, `account-deletion.service`), so holds never stand in
 * its way.
 *
 * Each change records `workspace.deletion_hold_set` or `workspace.deletion_hold_cleared` (on the change
 * feed like every workspace event), with the service as the actor, `target: {workspaceId, service}`,
 * and the service's hold before and after as `{reason, count}` (`count` null when it has none), null
 * where there was or is no hold.
 */

import {DELETION_HOLD_REASON_PATTERN, type WorkspaceDeletionHold} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {recordWorkspaceEvent} from "./audit.service"
import {fail} from "./workspace-error"
import {deletionHoldsOf, isId, loadActiveWorkspace} from "./workspace.service"

type HoldSnapshot = {reason: string; count: number | null}

/**
 * Set `service`'s hold on an active workspace, replacing the one it had. `reason` must match
 * `DELETION_HOLD_REASON_PATTERN`; `count`, when not absent or null, a positive safe integer
 * (`invalid_request` otherwise). An unknown workspace is `not_found`, a deleted one
 * `workspace_deleted`. Returns every hold on the workspace afterwards, sorted by service.
 */
export async function setDeletionHold(
  service: string,
  workspaceId: string,
  input: {reason: unknown; count?: unknown},
): Promise<WorkspaceDeletionHold[]> {
  const holder = validService(service)
  const wanted: HoldSnapshot = {reason: validReason(input?.reason), count: validCount(input?.count)}
  if (!isId(workspaceId)) fail("not_found", "workspace not found")
  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    const holds = deletionHoldsOf(workspace)
    const previous = holds.find(hold => hold.service === holder)
    const before = previous ? snapshot(previous) : null
    if (before && before.reason === wanted.reason && before.count === wanted.count) return holds

    const next = sortByService([
      ...holds.filter(hold => hold.service !== holder),
      {service: holder, reason: wanted.reason, ...(wanted.count === null ? {} : {count: wanted.count})},
    ])
    await writeHolds(session, workspaceId, next, {status: "active"})
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "workspace.deletion_hold_set",
      actor: {kind: "service", service: holder},
      target: {workspaceId, service: holder},
      before,
      after: wanted,
    })
    return next
  })
}

/**
 * Clear `service`'s hold. A workspace it does not hold (a deleted one included) is left as it is. An
 * unknown workspace is `not_found`. Returns the holds left on the workspace, sorted by service.
 */
export async function clearDeletionHold(service: string, workspaceId: string): Promise<WorkspaceDeletionHold[]> {
  const holder = validService(service)
  if (!isId(workspaceId)) fail("not_found", "workspace not found")
  return withTransaction(async session => {
    const workspace = await WorkspaceModel.findOne({workspaceId}).session(session).lean<WorkspaceRow>()
    if (!workspace) fail("not_found", "workspace not found")
    const holds = deletionHoldsOf(workspace)
    const previous = holds.find(hold => hold.service === holder)
    if (!previous) return holds

    const next = holds.filter(hold => hold.service !== holder)
    await writeHolds(session, workspaceId, next, {})
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "workspace.deletion_hold_cleared",
      actor: {kind: "service", service: holder},
      target: {workspaceId, service: holder},
      before: snapshot(previous),
      after: null,
    })
    return next
  })
}

/** Every hold on a workspace (in any status), sorted by service. An unknown workspace is `not_found`. */
export async function listDeletionHolds(workspaceId: string): Promise<WorkspaceDeletionHold[]> {
  if (!isId(workspaceId)) fail("not_found", "workspace not found")
  const workspace = await WorkspaceModel.findOne({workspaceId}).select({deletionHolds: 1}).lean<WorkspaceRow>()
  if (!workspace) fail("not_found", "workspace not found")
  return deletionHoldsOf(workspace)
}

// --- Helpers ---------------------------------------------------------------

/**
 * Store the holds, writing the workspace document: this is what makes a concurrent delete (which
 * writes it too) conflict with this transaction. `filter` narrows which state may be written.
 */
async function writeHolds(
  session: ClientSession,
  workspaceId: string,
  holds: WorkspaceDeletionHold[],
  filter: {status?: "active"},
): Promise<void> {
  const stored = holds.map(hold => ({service: hold.service, reason: hold.reason, count: hold.count ?? null}))
  const written = await WorkspaceModel.updateOne({workspaceId, ...filter}, {$set: {deletionHolds: stored}}, {session})
  if (written.matchedCount !== 1) fail("workspace_deleted", "workspace has been deleted")
}

function snapshot(hold: WorkspaceDeletionHold): HoldSnapshot {
  return {reason: hold.reason, count: hold.count ?? null}
}

function sortByService(holds: WorkspaceDeletionHold[]): WorkspaceDeletionHold[] {
  return holds.sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0))
}

function validService(service: unknown): string {
  if (!isId(service)) fail("invalid_request", "service is required")
  return service.trim()
}

function validReason(reason: unknown): string {
  if (typeof reason !== "string" || !DELETION_HOLD_REASON_PATTERN.test(reason)) {
    fail("invalid_request", "reason must be a lowercase code such as owns_miniapps")
  }
  return reason
}

function validCount(count: unknown): number | null {
  if (count === undefined || count === null) return null
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    fail("invalid_request", "count must be a positive whole number")
  }
  return count
}
