/**
 * Whether the signed-in account is managed by Mentra Fleet Management, from the last complete desired state its Core
 * answered. The assignment reconciler feeds it; the Mentra App shows the Fleet notice and the workspace page's
 * "Mentra Fleet Management" line from it.
 *
 * - `managed`: the last complete answer was `managed`, for this workspace.
 * - `unmanaged`: the last complete answer was `unmanaged`.
 * - `unknown`: signed out, or this account on this Core has never had a complete answer.
 *
 * An error, timeout, 503 or partial answer changes nothing, like it changes no assignment: the account keeps its last
 * answer. The answer is persisted per Core and account with the reconciler's state, so it survives restarts.
 */
export type FleetManagementState =
  | {status: "unknown"}
  | {status: "unmanaged"}
  | {status: "managed"; workspaceId: string; workspaceName: string}

const UNKNOWN: FleetManagementState = {status: "unknown"}

let current: FleetManagementState = UNKNOWN
const listeners = new Set<(state: FleetManagementState) => void>()

function same(a: FleetManagementState, b: FleetManagementState): boolean {
  if (a.status !== b.status) return false
  if (a.status !== "managed" || b.status !== "managed") return true
  return a.workspaceId === b.workspaceId && a.workspaceName === b.workspaceName
}

export function getFleetManagementState(): FleetManagementState {
  return current
}

/** Calls `listener` with each change. Returns the unsubscribe function. */
export function onFleetManagementStateChanged(listener: (state: FleetManagementState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The reconciler's feed. Notifies only on change. */
export function setFleetManagementState(next: FleetManagementState): void {
  if (same(current, next)) return
  current = next
  for (const listener of [...listeners]) {
    try {
      listener(next)
    } catch (error) {
      console.warn("Fleet management state listener threw", error)
    }
  }
}

/** Tests only. */
export function resetFleetManagementStateForTests(): void {
  current = UNKNOWN
  listeners.clear()
}
