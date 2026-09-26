import type { TestResourceObservation, TestResourceProgress } from "./test-resource-observation.types";

/**
 * Reviewed version-one example observations for cross-contract tests. The private
 * producer's `readLaneStatus` mapping should produce these for the equivalent
 * guard states. Data only; nothing here is read at runtime by Core.
 */

/** mini-03be as found: the original PID is dead, the shared guard retained the run, and
 * the checkpoint says `complete` while teardown/stop-recording is still pending. */
export function retainedObservation(runID = "discovery-46e1b113-108e-4769-8678-3bd2b8d10777", pid = 4242): TestResourceObservation {
  return {
    state: "retained-recovery-required", reason: "dead-retained-reservation",
    guard: { lock: "present", reclaimMarker: "absent" },
    owner: { valid: true, pid, liveness: "dead", retainOnExit: true, reservation: { runID, fixtureID: "03BE" }, retainedReason: "lifecycle-reservation" },
    lastCheckpoint: { available: true, runID, mode: "complete", phase: "teardown",
      pendingOperation: { phase: "teardown", stepID: "stop-recording" }, pendingReconciliation: null },
    fixture: { checked: true, record: "valid", fixtureID: "03BE", status: "busy", lastRunID: runID },
  };
}

/** A live owner holding its lifecycle reservation. */
export function aliveObservation(runID: string, pid = 5000): TestResourceObservation {
  return {
    state: "busy", reason: "owner-process-alive", guard: { lock: "present", reclaimMarker: "absent" },
    owner: { valid: true, pid, liveness: "alive", retainOnExit: true, reservation: { runID, fixtureID: "03BE" }, retainedReason: "lifecycle-reservation" },
    lastCheckpoint: { available: true, runID, mode: "running", phase: "test", pendingOperation: null, pendingReconciliation: null },
    fixture: { checked: true, record: "valid", fixtureID: "03BE", status: "busy", lastRunID: runID },
  };
}

/** No guard file; the recorded fixture state is only context. Displayed as "No owner observed". */
export function noOwnerObservation(lastRunID = "routine-1-1-dev-no-glasses"): TestResourceObservation {
  return {
    state: "available-to-attempt", reason: "no-guard-recorded-fixture-ready", guard: { lock: "absent", reclaimMarker: "absent" },
    fixture: { checked: true, record: "valid", fixtureID: "03BE", status: "ready", lastRunID },
  };
}

/** Existing lifecycle progress for the observed owner's run. */
export function resourceProgress(runId: string, sequence: number, label = "Stop recording"): TestResourceProgress {
  return { runId, sequence, mode: "running", phase: "teardown", step: { id: "stop-recording", label }, completedSteps: 0, totalSteps: 1 };
}
