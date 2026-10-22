/**
 * Whether Fleet manages this account, as the engine last heard it from the account's Core (`managed`, `unmanaged`,
 * or `unknown` before the first answer and when signed out). The engine keeps the last answer through errors, 503s
 * and timeouts, so a hiccup never reads as "no longer managed".
 */
import {
  getFleetManagementState,
  onFleetManagementStateChanged,
  type FleetManagementState,
} from "@mentra/engine-host-internal"
import {useSyncExternalStore} from "react"

export type {FleetManagementState}

/** The state now, and each change of it. */
export function useFleetManagementState(): FleetManagementState {
  return useSyncExternalStore(onFleetManagementStateChanged, getFleetManagementState, getFleetManagementState)
}

/** True only while the last complete answer was `managed`. */
export function useIsManagedByFleet(): boolean {
  return useFleetManagementState().status === "managed"
}
