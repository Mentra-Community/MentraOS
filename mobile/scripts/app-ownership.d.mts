export interface AppReservation {
  runID: string
  runDirectory: string
  fixtureID: string
}
export function acquireAppOwnership(
  folder?: string,
  options?: {installer?: boolean; reservation?: AppReservation; recovering?: boolean},
): Promise<() => Promise<void>>
