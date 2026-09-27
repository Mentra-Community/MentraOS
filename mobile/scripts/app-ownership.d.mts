export interface AppReservation {
  runID: string
  runDirectory: string
  fixtureID: string
}
export function retainedAppReservation(folder?: string): Promise<AppReservation | undefined>
export function glassesLeaseRoot(folder?: string): string
export function readLockState(
  folder: string,
): Promise<{state: "absent" | "reclaimable"} | {state: "held"; pid: number; reservation?: AppReservation}>
export function heldGlassesLeases(root: string): Promise<string[]>
export function acquireAppOwnership(
  folder?: string,
  options?: {installer?: boolean; reservation?: AppReservation; recovering?: boolean},
): Promise<() => Promise<void>>
