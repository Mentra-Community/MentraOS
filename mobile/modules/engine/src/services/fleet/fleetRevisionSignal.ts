/**
 * The seam between the Fleet reporter (which hears MFM's ack) and the assignment reconciler (which acts on it).
 *
 * Two directions, both cheap and non-throwing for the caller:
 *
 * - `signalFleetRevision(revision)`: the reporter calls it with each ack's `revision`. The reconciler listens
 *   (`onFleetRevision`) and fetches desired state when the revision is newer than the one it last applied.
 * - `emitAssignmentOutcome(outcome)`: the reconciler calls it whenever one assignment's state on this phone changes.
 *   The reporter listens (`onAssignmentOutcome`) and queues an `assignment_outcome` record.
 *
 * This module imports nothing at run time. A listener that throws is skipped, never thrown into the emitter.
 * The reconciler (W9) owns this file's behavior; the reporter (W15) only calls and listens through it.
 */
import type {FleetAssignmentOutcomePayload} from "@mentra/cloud-protocol"

export type FleetRevisionListener = (revision: number) => void
export type AssignmentOutcomeListener = (outcome: FleetAssignmentOutcomePayload) => void

const revisionListeners = new Set<FleetRevisionListener>()
const outcomeListeners = new Set<AssignmentOutcomeListener>()

/** Calls each listener and skips one that throws. */
function each<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value)
    } catch {
      // A broken listener must not break the emitter's path.
    }
  }
}

/** The reporter heard an ack carrying this per-account desired-state revision. */
export function signalFleetRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) return
  each(revisionListeners, revision)
}

/** The reconciler listens for acks. Returns the unsubscribe function. */
export function onFleetRevision(listener: FleetRevisionListener): () => void {
  revisionListeners.add(listener)
  return () => void revisionListeners.delete(listener)
}

/** One assignment's state on this phone changed. */
export function emitAssignmentOutcome(outcome: FleetAssignmentOutcomePayload): void {
  each(outcomeListeners, outcome)
}

/** The reporter listens for outcomes. Returns the unsubscribe function. */
export function onAssignmentOutcome(listener: AssignmentOutcomeListener): () => void {
  outcomeListeners.add(listener)
  return () => void outcomeListeners.delete(listener)
}

/** Test helper: forget every listener. */
export function resetFleetSignals(): void {
  revisionListeners.clear()
  outcomeListeners.clear()
}
