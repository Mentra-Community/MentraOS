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
 * (`deletionHolds`). Setting replaces the service's hold; clearing removes it. A change writes the
 * workspace document inside a transaction, as `deleteWorkspace` does, so the two conflict and
 * serialize: either the hold lands first and the delete is refused, or the delete lands first and the
 * hold is refused (`workspace_deleted`). A deleted workspace therefore never has a hold, and clearing
 * one there is the no-op it looks like.
 *
 * Every set and clear carries `asOf`, the instant the service computed it. Core keeps, per service,
 * the newest `asOf` it has applied (`deletionHoldAsOf`, a clear's included) and ignores a call that is
 * not newer: it answers the holds it keeps with `ignored: true`, and writes and records nothing. So a
 * call the service gave up on (a timeout) that reaches Core late never overwrites a newer hold, and a
 * late set never brings back a hold a newer clear removed. The same call again with the same `asOf`
 * (a retry) is answered as applied; another hold with that `asOf` is ignored. A newer call that changes
 * no hold still writes its `asOf` (and nothing else: no audit entry, `updatedAt` untouched), so a late
 * call from before it stays stale. An `asOf` more than five minutes ahead of Core's clock is refused,
 * so one service's runaway clock cannot shut out its later calls for long.
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

import {
  DELETION_HOLD_MAX_FUTURE_SKEW_MS,
  DELETION_HOLD_REASON_PATTERN,
  type WorkspaceDeletionHold,
} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {recordWorkspaceEvent} from "./audit.service"
import {fail} from "./workspace-error"
import {deletionHoldsOf, isId, loadActiveWorkspace} from "./workspace.service"

type HoldSnapshot = {reason: string; count: number | null}

/** What a set or clear did: every hold on the workspace afterwards, and whether Core ignored the call as stale. */
export interface DeletionHoldChange {
  holds: WorkspaceDeletionHold[]
  ignored: boolean
}

/**
 * Set `service`'s hold on an active workspace, replacing the one it had. `reason` must match
 * `DELETION_HOLD_REASON_PATTERN`; `count`, when not absent or null, a positive safe integer; `asOf`
 * an ISO 8601 UTC instant at most five minutes ahead of Core's clock (`invalid_request` otherwise).
 * An unknown workspace is `not_found`, a deleted one `workspace_deleted`. A call that is not newer
 * than the service's last applied one is ignored. Returns every hold on the workspace afterwards,
 * sorted by service.
 */
export async function setDeletionHold(
  service: string,
  workspaceId: string,
  input: {reason: unknown; count?: unknown; asOf: unknown},
): Promise<DeletionHoldChange> {
  const holder = validService(service)
  const wanted: HoldSnapshot = {reason: validReason(input?.reason), count: validCount(input?.count)}
  const asOf = validAsOf(input?.asOf)
  if (!isId(workspaceId)) fail("not_found", "workspace not found")
  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    const holds = deletionHoldsOf(workspace)
    const previous = holds.find(hold => hold.service === holder)
    const before = previous ? snapshot(previous) : null
    const unchanged = before !== null && before.reason === wanted.reason && before.count === wanted.count
    const order = callOrder(workspace, holder, asOf)
    if (order === "same") return {holds, ignored: !unchanged}
    if (order === "older") return {holds, ignored: true}

    if (unchanged) {
      await writeHolds(session, workspace, holder, asOf, null, {status: "active"})
      return {holds, ignored: false}
    }
    const next = sortByService([
      ...holds.filter(hold => hold.service !== holder),
      {service: holder, reason: wanted.reason, ...(wanted.count === null ? {} : {count: wanted.count})},
    ])
    await writeHolds(session, workspace, holder, asOf, next, {status: "active"})
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "workspace.deletion_hold_set",
      actor: {kind: "service", service: holder},
      target: {workspaceId, service: holder},
      before,
      after: wanted,
    })
    return {holds: next, ignored: false}
  })
}

/**
 * Clear `service`'s hold. `asOf` is as for `setDeletionHold`, and is kept after the clear. A workspace
 * it does not hold (a deleted one included) is left as it is. An unknown workspace is `not_found`.
 * Returns the holds left on the workspace, sorted by service.
 */
export async function clearDeletionHold(
  service: string,
  workspaceId: string,
  input: {asOf: unknown},
): Promise<DeletionHoldChange> {
  const holder = validService(service)
  const asOf = validAsOf(input?.asOf)
  if (!isId(workspaceId)) fail("not_found", "workspace not found")
  return withTransaction(async session => {
    const workspace = await WorkspaceModel.findOne({workspaceId}).session(session).lean<WorkspaceRow>()
    if (!workspace) fail("not_found", "workspace not found")
    const holds = deletionHoldsOf(workspace)
    const previous = holds.find(hold => hold.service === holder)
    const order = callOrder(workspace, holder, asOf)
    if (order === "same") return {holds, ignored: previous !== undefined}
    if (order === "older") return {holds, ignored: true}

    // A deleted workspace never has a hold, and can never take one again: nothing to clear or remember.
    if (workspace.status !== "active") return {holds, ignored: false}
    if (!previous) {
      await writeHolds(session, workspace, holder, asOf, null, {})
      return {holds, ignored: false}
    }
    const next = holds.filter(hold => hold.service !== holder)
    await writeHolds(session, workspace, holder, asOf, next, {})
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "workspace.deletion_hold_cleared",
      actor: {kind: "service", service: holder},
      target: {workspaceId, service: holder},
      before: snapshot(previous),
      after: null,
    })
    return {holds: next, ignored: false}
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

/** A UTC instant with a `Z`, to the millisecond at most: what Core can keep exactly and compare. */
const UTC_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/

/**
 * Where a call stamped `asOf` falls against the newest one Core applied from `holder` on this
 * workspace: `newer` (or the first), the `same` instant, or `older`.
 */
function callOrder(workspace: WorkspaceRow, holder: string, asOf: Date): "newer" | "same" | "older" {
  const stored = (workspace.deletionHoldAsOf ?? []).find(entry => entry.service === holder)?.asOf
  if (!stored) return "newer"
  const difference = asOf.getTime() - stored.getTime()
  return difference > 0 ? "newer" : difference === 0 ? "same" : "older"
}

/**
 * Keep `asOf` as `holder`'s newest call, and store `holds` unless null (the call changed no hold),
 * writing the workspace document: this is what makes a concurrent delete (which writes it too)
 * conflict with this transaction. `filter` narrows which state may be written. A write that changes
 * no hold leaves `updatedAt` alone: the workspace has not changed.
 */
async function writeHolds(
  session: ClientSession,
  workspace: WorkspaceRow,
  holder: string,
  asOf: Date,
  holds: WorkspaceDeletionHold[] | null,
  filter: {status?: "active"},
): Promise<void> {
  const stamps = [
    ...(workspace.deletionHoldAsOf ?? [])
      .filter(entry => entry.service !== holder)
      .map(entry => ({service: entry.service, asOf: entry.asOf})),
    {service: holder, asOf},
  ].sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0))
  const update: Record<string, unknown> = {deletionHoldAsOf: stamps}
  if (holds) {
    update.deletionHolds = holds.map(hold => ({service: hold.service, reason: hold.reason, count: hold.count ?? null}))
  }
  const written = await WorkspaceModel.updateOne(
    {workspaceId: workspace.workspaceId, ...filter},
    {$set: update},
    {session, timestamps: holds !== null},
  )
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

/**
 * `asOf` as a Date: an ISO 8601 UTC instant (`2026-10-14T12:00:00.000Z`) that names a real time, no more
 * than five minutes ahead of Core's clock. `Date.parse` alone is not enough: it moves a calendar-invalid
 * date (`2026-02-30`) or `24:00:00` to another instant, so the instant must format back to the input.
 */
function validAsOf(asOf: unknown): Date {
  const match = typeof asOf === "string" ? UTC_INSTANT.exec(asOf) : null
  const instant = match ? Date.parse(asOf as string) : Number.NaN
  if (
    !match ||
    Number.isNaN(instant) ||
    new Date(instant).toISOString() !== `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`
  ) {
    fail("invalid_request", "asOf must be an ISO 8601 UTC instant such as 2026-10-14T12:00:00.000Z")
  }
  if (instant > Date.now() + DELETION_HOLD_MAX_FUTURE_SKEW_MS) {
    fail("invalid_request", "asOf is more than five minutes ahead of Core's clock")
  }
  return new Date(instant)
}
