import { createHash } from "node:crypto";
import type { TestFailure, TestFailureOccurrence } from "../types/test-failure.types";
import { testRunIdSchema, type TestRun } from "../types/test-run.types";
import { createTestFailureOccurrences } from "./test-failure-occurrence";

/** Server-derived links; never accepted from the publisher as an occurrence or receipt. */
export interface TestRecoveryLineage {
  schemaVersion: 1;
  generation: number;
  originalRunId: string;
  originalPayloadSha256?: string;
  previousResultRunId: string;
  previousPayloadSha256?: string;
  inheritedFailures: Array<{ failureIndex: number; occurrenceId: string; runId: string; payloadSha256: string }>;
  /** Publication remains independent when Core cannot prove ancestry for deduplication. */
  unavailableReason?: "original-not-published" | "parent-not-published" | "ancestor-provenance-unavailable"
    | "ancestor-occurrences-unavailable" | "legacy-ancestry-unavailable";
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
function identity(run: TestRun, includeSource: boolean) {
  return { requestId: run.requestId, routineId: run.routineId, routineVersion: run.routineVersion,
    platform: run.platform, channel: run.channel, prNumber: run.prNumber, release: run.release,
    startedAt: run.startedAt, source: includeSource ? run.source : undefined, fixture: run.fixture,
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

/** Resolve only against accepted results. Unavailable ancestry keeps ordinary independent intake. */
export async function testFailureProjection(run: TestRun, get: (id: string) => Promise<StoredResult | null>, remainingAncestors = 20): Promise<TestFailureProjection> {
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
  const unavailable = (unavailableReason: NonNullable<TestRecoveryLineage["unavailableReason"]>): TestFailureProjection => ({
    failureOccurrences: occurrences, recoveryLineage: { schemaVersion: 1, generation, originalRunId: p.originalRunId!,
      previousResultRunId: p.previousResultRunId!, inheritedFailures: [], unavailableReason },
  });
  const original = await get(p.originalRunId!);
  const parent = generation === 2 ? original : await get(p.previousResultRunId!);
  const byStep = new Map(occurrences.map(item => [phaseStep(item.failure), item]));
  // Missing ancestry only disables deduplication. Every result Core does have
  // still constrains the incoming identity, test, evidence and retained failures.
  for (const known of new Set([original, parent])) {
    if (!known) continue;
    // A legacy result may lack source metadata; its other identity fields are still known.
    const includeSource = !!known.run.source;
    if (!same(identity(run, includeSource), identity(known.run, includeSource)))
      reject("recovery changed the original routine, request, source or build identity");
    if (Date.parse(run.finishedAt) < Date.parse(known.run.finishedAt) || run.outcomes.test !== known.run.outcomes.test)
      reject("recovery cannot replace the original test or evidence outcome");
    for (const occurrence of createTestFailureOccurrences(known.run)) {
      if (!byStep.has(phaseStep(occurrence.failure))) reject("recovery omitted an inherited failure");
    }
  }
  const originalTerminal = original?.run.provenance.terminalSnapshotSha256 ?? original?.run.provenance.lifecycleTerminalSha256;
  const parentTerminal = generation === 2 ? originalTerminal : parent?.run.provenance.terminalSnapshotSha256;
  if (original && (original.run.provenance.originalRunId || original.run.provenance.previousResultRunId
    || (original.run.provenance.resultGeneration && original.run.provenance.resultGeneration !== "1"))
    || (digest.test(originalTerminal ?? "") && (p.originalTerminalSnapshotSha256 !== originalTerminal
      || p.terminalSnapshotSha256 === originalTerminal))
    || (digest.test(parentTerminal ?? "") && p.terminalSnapshotSha256 === parentTerminal))
    reject("recovery terminal does not extend the recorded original and parent results");
  if (original && ((original.run.outcome === "failed" && run.outcome !== "failed")
    || (original.run.outcome !== "passed" && run.outcome === "passed")
    || (original.run.outcomes.evidence === "incomplete" && run.outcomes.evidence !== "incomplete")))
    reject("recovery cannot replace the original test or evidence outcome");
  if (!original) return unavailable("original-not-published");
  if (!parent) return unavailable("parent-not-published");
  const root = original, previous = parent;
  if (!digest.test(originalTerminal ?? "") || !digest.test(parentTerminal ?? "") || !root.run.source || !previous.run.source)
    return unavailable("ancestor-provenance-unavailable");
  if (generation > 2) {
    let lineage = previous.recoveryLineage;
    if (!lineage || lineage.unavailableReason) {
      // Validate legacy ancestry on demand, without replacing any already accepted
      // occurrences, receipts or payloads. Bound reads even for very long histories.
      if (remainingAncestors === 0) return unavailable("legacy-ancestry-unavailable");
      try { lineage = (await testFailureProjection(previous.run, get, remainingAncestors - 1)).recoveryLineage; }
      catch (error) {
        if (!(error instanceof RecoveryLineageError)) throw error;
        return unavailable("legacy-ancestry-unavailable");
      }
    }
    if (!lineage || lineage.unavailableReason) return unavailable("legacy-ancestry-unavailable");
    if (lineage.generation !== generation - 1 || lineage.originalRunId !== root.run.runId
      || lineage.originalPayloadSha256 !== root.payloadSha256) reject("recovery parent contradicts this original result");
  }
  if (previous.failureOccurrences === undefined || root.failureOccurrences === undefined)
    return unavailable("ancestor-occurrences-unavailable");
  const parentFailures = createTestFailureOccurrences(previous.run);
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
