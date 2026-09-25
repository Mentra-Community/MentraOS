import { createHash } from "node:crypto";
import type { TestFailure, TestFailureOccurrence } from "../types/test-failure.types";
import type { TestRun } from "../types/test-run.types";

/** Deterministic identity excludes message, timestamp, upload state and delivery attempts. */
export function testFailureOccurrenceId(runId: string, phase: string, stepId: string | null): string {
  return `tfo_${createHash("sha256").update(JSON.stringify([runId, phase, stepId])).digest("hex")}`;
}

export function createTestFailureOccurrences(run: TestRun): TestFailureOccurrence[] {
  if (run.outcome === "passed") return [];
  // Legacy/incomplete results remain discoverable. Do not guess a source branch,
  // failing action, product diagnosis or safe diagnostic asset from free text.
  const failures: TestFailure[] = run.failures ?? [{
    phase: "unknown", step: null, code: `run_${run.outcome}`,
    message: `The routine ended with outcome ${run.outcome}; structured failure details were not published.`,
    assetIds: [], incidentIds: [], redactionPolicy: "core-generated-summary-v1",
    missingEvidence: [{ kind: "failure-details", reason: "This publisher did not supply structured failure metadata." }],
  }];
  return failures.map(failure => ({
    occurrenceId: testFailureOccurrenceId(run.runId, failure.phase, failure.step?.id ?? null),
    revision: 1, failure,
    delivery: { state: "pending" },
  }));
}
