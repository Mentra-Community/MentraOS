/**
 * Deletion holds in words, for everyone who shows one: Core's 409 `workspace_has_holds`, the workspace
 * portal, the admin portal and the Developer Console all say the same thing. Browser-safe.
 */
import {OWNS_MINIAPPS_HOLD_REASON, type WorkspaceDeletionHold} from "./types"

/** What one hold means for the person trying to delete the workspace, as a sentence or two. */
export function describeDeletionHold(hold: WorkspaceDeletionHold): string {
  const count = typeof hold.count === "number" ? hold.count : undefined
  if (hold.service === "store" && hold.reason === OWNS_MINIAPPS_HOLD_REASON) {
    if (count === 1) return "This workspace still owns 1 miniapp. Delete it in the Developer Console first."
    const owned = count === undefined ? "miniapps" : `${count} miniapps`
    return `This workspace still owns ${owned}. Delete them in the Developer Console first.`
  }
  const reason = hold.reason.replace(/_/g, " ")
  return `The ${hold.service} service still needs this workspace (${reason}${count === undefined ? "" : `: ${count}`}). Resolve that before deleting it.`
}

/** Every hold in words, one after another. */
export function describeDeletionHolds(holds: readonly WorkspaceDeletionHold[]): string {
  return holds.map(describeDeletionHold).join(" ")
}

/** Whether `value` has the wire shape of a hold: a service and a reason, and a positive whole `count` when it has one. */
export function isWorkspaceDeletionHold(value: unknown): value is WorkspaceDeletionHold {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const hold = value as Record<string, unknown>
  if (typeof hold.service !== "string" || !hold.service || typeof hold.reason !== "string" || !hold.reason) return false
  return hold.count === undefined || (typeof hold.count === "number" && Number.isSafeInteger(hold.count) && hold.count >= 1)
}
