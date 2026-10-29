/** Staging support action: retain license tombstones so delayed billing writes cannot restore access. */
import {withTransaction} from "../../connections/mongo.connection"
import {LicenseModel} from "../../models/license.model"
import {LicenseSeatModel} from "../../models/license-seat.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {recordWorkspaceEvent} from "../workspaces/audit.service"
import {fail} from "../workspaces/workspace-error"
import {auditActor, getWorkspace, touchWorkspace, type Actor} from "../workspaces/workspace.service"
import {endLicensesForOwner} from "./license.service"

export function requireStagingLicenseReset(): void {
  if (process.env.CLOUD_CORE_ENVIRONMENT !== "staging") fail("forbidden", "license resets are available on staging only")
}

export function validateLicenseReset(workspaceId: string, body: Record<string, unknown>): string {
  requireStagingLicenseReset()
  if (body.confirmWorkspaceId !== workspaceId) fail("invalid_request", "type the exact workspace ID to confirm")
  if (typeof body.reason !== "string" || body.reason.trim().length < 5 || body.reason.length > 500) fail("invalid_request", "a reason of 5 to 500 characters is required")
  return body.reason.trim()
}

export async function licenseResetPreview(workspaceId: string) {
  requireStagingLicenseReset()
  const workspace = await getWorkspace(workspaceId)
  if (!workspace || workspace.status !== "active") fail("not_found", "active workspace not found")
  const licenses = await LicenseModel.find({"owner.workspaceId": workspaceId, endedAt: null}, {quantity: 1}).lean()
  const assignments = await LicenseSeatModel.countDocuments({workspaceId})
  return {workspaceId, name: workspace.name, products: licenses.length, licenses: licenses.reduce((sum, row) => sum + row.quantity, 0), assignments}
}

export interface ResetBillingResult {licenseIds: string[]; canceledSubscriptions: number; expiredCheckouts: number}

/** Billing must have canceled successfully before this transaction can remove any license access. */
export async function finishLicenseReset(actor: Actor, workspaceId: string, reason: string, billing: ResetBillingResult) {
  requireStagingLicenseReset()
  if (actor.kind !== "user" || !actor.isOrganizationAdmin) fail("forbidden", "an Organization Admin is required")
  return withTransaction(async session => {
    await touchWorkspace(session, workspaceId)
    const live = await LicenseModel.find({"owner.workspaceId": workspaceId, endedAt: null}).session(session).lean()
    const known = new Set(billing.licenseIds)
    if (live.some(row => !known.has(row._id))) fail("membership_changed", "workspace billing changed during the reset; retry safely")
    // Retire every billing ID, including failed or in-flight first deliveries. Crossing license writes
    // touch this same workspace document, so their transaction retries and observes the retirement.
    await WorkspaceModel.updateOne({workspaceId, status: "active"}, {$addToSet: {retiredLicenseIds: {$each: billing.licenseIds}}}, {session})
    const assignments = await LicenseSeatModel.countDocuments({workspaceId}).session(session)
    const ended = await endLicensesForOwner(session, {type: "workspace", workspaceId}, "admin_reset", actor)
    await recordWorkspaceEvent(session, {
      workspaceId, action: "workspace.licenses.reset", actor: auditActor(actor), target: {workspaceId},
      before: {products: live.length, assignments}, after: {reason, endedLicenseIds: ended, ...billing},
    })
    return {endedProducts: ended.length, releasedAssignments: assignments, canceledSubscriptions: billing.canceledSubscriptions, expiredCheckouts: billing.expiredCheckouts}
  })
}
