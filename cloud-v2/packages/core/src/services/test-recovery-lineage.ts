import { createHash } from "node:crypto";
import type { TestFailure, TestFailureOccurrence } from "../types/test-failure.types";
import { testRunIdSchema, type TestRun } from "../types/test-run.types";
import { createTestFailureOccurrences } from "./test-failure-occurrence";

/** Server-derived links; never accepted from the publisher as an occurrence or receipt. */
export interface TestRecoveryLineage {
  schemaVersion: 1;
  generation: number;
  originalRunId: string;
  originalPayloadSha256: string;
  previousResultRunId: string;
  previousPayloadSha256: string;
  inheritedFailures: Array<{ failureIndex: number; occurrenceId: string; runId: string; payloadSha256: string }>;
}
export interface TestFailureProjection {
  failureOccurrences: TestFailureOccurrence[];
  recoveryLineage?: TestRecoveryLineage;
}
type StoredResult = { run: TestRun; payloadSha256: string; failureOccurrences?: TestFailureOccurrence[];
  recoveryLineage?: TestRecoveryLineage };
export class RecoveryLineageError extends Error {}
const reject = (message: string): never => { throw new RecoveryLineageError(message); };
const digest = /^[a-f0-9]{64}$/;
const canonical = (value: unknown): string => JSON.stringify(value, function (_key, item) {
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const recoveryResultRunId = (originalRunId: string, generation: number) =>
  `recovery-${createHash("sha256").update(originalRunId).digest("hex").slice(0, 32)}-${generation}`;

// These bind the original test and selected build, not the later cleanup implementation.
const identityProvenance = ["repository", "headSha", "baseSha", "branch", "buildSha", "harnessSha", "harnessRevision",
  "archiveSha256", "receiptSha256", "manifestSha256", "requestSha256", "claimSha256", "definitionDigest",
  "qualificationDigest", "returnProfileDigest", "mobileSourceCommit", "appRepository", "appSourceCommit",
  "appExecutableSha256", "appJavascriptSha256", "executionMode"] as const;
function identity(run: TestRun) {
  return { requestId: run.requestId, routineId: run.routineId, routineVersion: run.routineVersion,
    platform: run.platform, channel: run.channel, prNumber: run.prNumber, release: run.release,
    startedAt: run.startedAt, source: run.source, fixture: run.fixture,
    provenance: Object.fromEntries(identityProvenance.map(key => [key, run.provenance[key]])) };
}
const phaseStep = (failure: TestFailure) => canonical([failure.phase, failure.step?.id ?? null]);
// Only unordered collections are normalized. Error text/code/stack, redaction, and
// diagnostic bytes remain significant; a changed failure must get its own intake.
function failureIdentity(failure: TestFailure, run: TestRun) {
  return canonical({ ...failure, assetIds: [...failure.assetIds].sort(), incidentIds: [...failure.incidentIds].sort(),
    missingEvidence: failure.missingEvidence.map(canonical).sort(),
    assets: failure.assetIds.map(id => run.assets.find(asset => asset.assetId === id)).map(canonical).sort() });
}

/** Resolve only against accepted immutable results. Missing or forged lineage fails before any write. */
export async function testFailureProjection(run: TestRun, get: (id: string) => Promise<StoredResult | null>): Promise<TestFailureProjection> {
  const occurrences = createTestFailureOccurrences(run), p = run.provenance;
  if (!p.originalRunId && !p.previousResultRunId && (!p.resultGeneration || p.resultGeneration === "1")
    && !/^recovery-[a-f0-9]{32}-/.test(run.runId)) return { failureOccurrences: occurrences };
  const generation = Number(p.resultGeneration);
  if (!/^[1-9]\d*$/.test(p.resultGeneration ?? "") || !Number.isSafeInteger(generation) || generation < 2
    || !testRunIdSchema.safeParse(p.originalRunId).success
    || run.runId !== recoveryResultRunId(p.originalRunId!, generation)
    || p.previousResultRunId !== (generation === 2 ? p.originalRunId : recoveryResultRunId(p.originalRunId!, generation - 1))
    || !digest.test(p.terminalSnapshotSha256 ?? "") || !digest.test(p.originalTerminalSnapshotSha256 ?? ""))
    reject("recovery result has invalid generation, parent identity or terminal hashes");
  const original = await get(p.originalRunId!);
  const parent = generation === 2 ? original : await get(p.previousResultRunId!);
  if (!original || !parent) reject("recovery requires its original and immediate parent results to be published first");
  const root = original!, previous = parent!;
  const originalTerminal = root.run.provenance.terminalSnapshotSha256 ?? root.run.provenance.lifecycleTerminalSha256;
  const parentTerminal = generation === 2 ? originalTerminal : previous.run.provenance.terminalSnapshotSha256;
  if (root.run.provenance.originalRunId || root.run.provenance.previousResultRunId
    || (root.run.provenance.resultGeneration && root.run.provenance.resultGeneration !== "1")
    || !digest.test(originalTerminal ?? "") || p.originalTerminalSnapshotSha256 !== originalTerminal
    || !digest.test(parentTerminal ?? "") || p.terminalSnapshotSha256 === parentTerminal)
    reject("recovery terminal does not extend the recorded original and parent results");
  if (generation > 2 && (!previous.recoveryLineage || previous.recoveryLineage.generation !== generation - 1
    || previous.recoveryLineage.originalRunId !== root.run.runId
    || previous.recoveryLineage.originalPayloadSha256 !== root.payloadSha256))
    reject("recovery parent has no validated lineage to this original result");
  if (!root.run.source || !same(identity(run), identity(root.run)) || !same(identity(previous.run), identity(root.run)))
    reject("recovery changed the original routine, request, source or build identity");
  if (Date.parse(run.finishedAt) < Date.parse(previous.run.finishedAt) || run.outcomes.test !== root.run.outcomes.test
    || (root.run.outcome === "failed" && run.outcome !== "failed")
    || (root.run.outcome !== "passed" && run.outcome === "passed")
    || (root.run.outcomes.evidence === "incomplete" && run.outcomes.evidence !== "incomplete"))
    reject("recovery cannot replace the original test or evidence outcome");
  if (previous.failureOccurrences === undefined || root.failureOccurrences === undefined)
    reject("replay the accepted parent metadata to persist its failure occurrences before recovery");
  const byStep = new Map(occurrences.map(item => [phaseStep(item.failure), item]));
  const parentFailures = createTestFailureOccurrences(previous.run);
  for (const occurrence of parentFailures) {
    if (!byStep.has(phaseStep(occurrence.failure))) reject("recovery omitted an inherited failure");
  }
  const recoveryLineage: TestRecoveryLineage = { schemaVersion: 1, generation, originalRunId: root.run.runId,
    originalPayloadSha256: root.payloadSha256, previousResultRunId: previous.run.runId,
    previousPayloadSha256: previous.payloadSha256, inheritedFailures: [] };
  const failureOccurrences = occurrences.filter((occurrence, failureIndex) => {
    const parentIndex = parentFailures.findIndex(item => phaseStep(item.failure) === phaseStep(occurrence.failure)
      && failureIdentity(item.failure, previous.run) === failureIdentity(occurrence.failure, run));
    if (parentIndex < 0) return true;
    const parentOccurrence = previous.failureOccurrences!.find(item => item.occurrenceId === parentFailures[parentIndex]!.occurrenceId);
    const reference = previous.recoveryLineage?.inheritedFailures.find(item => item.failureIndex === parentIndex);
    if (!parentOccurrence && !reference) reject("recovery parent has no persisted occurrence for the inherited failure");
    recoveryLineage.inheritedFailures.push({ failureIndex,
      occurrenceId: parentOccurrence?.occurrenceId ?? reference!.occurrenceId,
      runId: parentOccurrence ? previous.run.runId : reference!.runId,
      payloadSha256: parentOccurrence ? previous.payloadSha256 : reference!.payloadSha256 });
    return false;
  });
  return { recoveryLineage, failureOccurrences };
}
