import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { TestRunModel } from "../models/test-run.model";
import type { TestRun } from "../types/test-run.types";
import { MongoTestRunRepository, TestRunService } from "./test-run.service";
import { TestFailureCorrectionService } from "./test-failure-correction.service";
import { MongoEvidenceSupplementRepository } from "./test-failure-evidence.service";
import type { EvidenceSupplement } from "../types/test-failure-evidence.types";

// Optional real Mongo proof; never use an existing database or non-loopback host.
const uri = process.env.TEST_FAILURE_MONGO_URI;
describe.skipIf(!uri)("Mongo failure occurrence durability", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("Failure tests require a plain loopback Mongo URL");
    url.pathname = `/test_failures_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
    connected = true;
    await TestRunModel.createIndexes();
  });
  afterAll(async () => {
    if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  });
  const fixture = (runId: string): TestRun => ({
    runId, requestId: "request", routineId: "no-glasses-android", routineVersion: "1", platform: "android", channel: "dev",
    startedAt: "2026-09-24T00:00:00Z", finishedAt: "2026-09-24T00:01:00Z", outcome: "failed",
    outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "incomplete" },
    provenance: { repository: "Mentra-Community/MentraOS" }, fixture: { alias: "phone" },
    firmwareAssertions: [], chapters: [], assets: [],
  });

  test("concurrent evidence additions enforce the per-occurrence bound without touching the payload", async () => {
    const service = new TestRunService(), result = await service.ingest(fixture("evidence-race"));
    const occurrenceId = result.occurrenceIds[0]!, agentRunId = randomUUID();
    await service.acknowledgeFailure(occurrenceId, agentRunId);
    const before = await TestRunModel.findOne({ runId: result.runId }).lean(), repository = new MongoEvidenceSupplementRepository();
    const value = (index: number): EvidenceSupplement => {
      const digest = index.toString(16).padStart(64, "0"), identity = { schemaVersion: 1 as const, environment: "dev" as const,
        testRunId: result.runId, payloadSha256: result.payloadSha256, occurrenceId, revision: 1 as const, agentRunId,
        target: { caseId: `mfc_${"b".repeat(64)}`, caseRevision: index, sessionSha256: "c".repeat(64) } };
      return { reference: { ...identity, supplementId: `tes_${digest}`, supplementSha256: digest },
        manifest: { ...identity, reason: "Synthetic concurrency contract proof.", redactionPolicy: "reviewed-harness-diagnostic-v1",
          assets: [{ assetId: "synthetic", sizeBytes: 2, sha256: "d".repeat(64) }] },
        reviewedBy: "synthetic", reviewedAt: new Date().toISOString(), delivery: { state: "pending" } };
    };
    await Promise.all(Array.from({ length: 8 }, (_, index) => repository.append(value(index))));
    const rows = await repository.list(result.runId); expect(rows).toHaveLength(2);
    const after = await TestRunModel.findOne({ runId: result.runId }).lean();
    expect(after!.payload).toEqual(before!.payload); expect(after!.payloadSha256).toBe(before!.payloadSha256);
    expect(after!.failureOccurrences).toEqual(before!.failureOccurrences); expect(after!.uploadsComplete).toBe(before!.uploadsComplete);
    await repository.settle(rows[0]!.reference.supplementId, { state: "acknowledged", agentRunId: randomUUID(), acknowledgedAt: new Date().toISOString() });
    expect((await repository.list(result.runId))[0]!.delivery.state).toBe("pending");
  });

  test("concurrent metadata retries create one occurrence, and passing runs share no failure identity", async () => {
    const run = fixture("concurrent");
    const results = await Promise.all(Array.from({ length: 12 }, () => new TestRunService().ingest(run)));
    expect(results.filter(item => item.created)).toHaveLength(1);
    expect(new Set(results.flatMap(item => item.occurrenceIds)).size).toBe(1);
    expect(await TestRunModel.countDocuments({ runId: run.runId })).toBe(1);
    for (const id of ["pass-1", "pass-2"]) {
      const passed = { ...fixture(id), outcome: "passed" as const,
        outcomes: { test: "passed" as const, teardown: "passed" as const, fixture: "ready" as const, evidence: "complete" as const } };
      expect((await new TestRunService().ingest(passed)).occurrenceIds).toEqual([]);
    }
  });

  test("competing acknowledgments choose one receipt and restart/replay preserves it", async () => {
    const run = fixture("ack-race");
    const id = (await new TestRunService().ingest(run)).occurrenceIds[0]!;
    const attempts = await Promise.allSettled(["agent_first", "agent_second"].map(agent => new TestRunService().acknowledgeFailure(id, agent)));
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const before = (await new TestRunService().failureDetail(id)).delivery;
    await new TestRunService().ingest(run);
    expect((await new TestRunService().failureDetail(id)).delivery).toEqual(before);
    expect((await new TestRunService().failureDetail(id)).originalOutcome).toBe("failed");
  });

  test("old-row reconciliation and pending delivery use persisted occurrence identity", async () => {
    const run = fixture("old-row");
    const id = (await new TestRunService().ingest(run)).occurrenceIds[0]!;
    await TestRunModel.updateOne({ runId: run.runId }, { $unset: { failureOccurrences: "" } });
    const reconciled = await Promise.all([new TestRunService().ingest(run), new TestRunService().ingest(run)]);
    expect(reconciled.map(item => item.occurrenceIds)).toEqual([[id], [id]]);
    const repository = new MongoTestRunRepository();
    await repository.noteFailureDeliveryAttempt(id);
    const pending = await repository.pendingFailures(10);
    expect(pending.flatMap(item => item.failureOccurrences ?? []).find(item => item.occurrenceId === id)?.delivery)
      .toMatchObject({ state: "pending", lastAttemptAt: expect.any(String) });
  });

  test("a reviewed correction is one conditional append beside the untouched acceptance, and settles only to its anchor", async () => {
    const head = "d".repeat(40), video = "a".repeat(64), meta = "b".repeat(64);
    const run: TestRun = { ...fixture("correction"), channel: "local", outcome: "blocked", provenance: { repository: "Mentra-Community/MentraOS", headSha: head },
      chapters: [{ id: "gate", instruction: "Press Back", phase: "test", status: "failed", videoAssetId: "gate-video" }],
      assets: [{ assetId: "gate-video", kind: "video", contentType: "video/mp4", filename: "gate.mp4", sizeBytes: 10, sha256: video },
        { assetId: "meta", kind: "metadata", contentType: "application/json", filename: "meta.json", sizeBytes: 5, sha256: meta }] };
    const ingested = await new TestRunService().ingest(run), id = ingested.occurrenceIds[0]!;
    const repository = new MongoTestRunRepository();
    for (const asset of run.assets) await repository.insertAsset({ runId: run.runId, assetId: asset.assetId, storageKey: `k/${asset.assetId}`,
      sizeBytes: asset.sizeBytes, sha256: asset.sha256 });
    await new TestRunService().acknowledgeFailure(id, "anchor_run");
    const before = await TestRunModel.findOne({ runId: run.runId }).lean();
    const request = (reason: string) => ({ schemaVersion: 1, confirmation: "add-reviewed-provenance", environment: "dev", runId: run.runId,
      payloadSha256: ingested.payloadSha256, occurrenceId: id, occurrenceRevision: 1, agentRunId: "anchor_run", reason,
      source: { schemaVersion: 1, trigger: "local", repository: "Mentra-Community/MentraOS", channel: "local", headSha: head, branch: "dev" },
      diagnostics: { assets: [{ assetId: "gate-video", sha256: video, chapterId: "gate" }],
        redaction: { policy: "routine-diagnostics-v1", confirmation: "reviewed-redacted-for-occurrence-access" } },
      review: { evidence: [{ assetId: "meta", sha256: meta }] } });
    const service = () => new TestFailureCorrectionService(new MongoTestRunRepository(), () => "dev" as const);
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => service().submit(run.runId, id, request("Reviewed launcher metadata for this local run."), "admin_a")),
      ...Array.from({ length: 3 }, (_, index) => service().submit(run.runId, id, request(`A competing, different review conclusion ${index}.`), "admin_b")),
    ]);
    const kept = (await TestRunModel.findOne({ runId: run.runId }).lean())!;
    expect(kept.provenanceCorrections).toHaveLength(1);
    const winner = (kept.provenanceCorrections as Array<{ correctionSha256: string; reason: string }>)[0]!;
    for (const result of results) {
      if (result.status === "fulfilled") expect(result.value.correction.correctionSha256).toBe(winner.correctionSha256);
      else expect(result.reason).toMatchObject({ status: 409 });
    }
    expect({ payload: kept.payload, payloadSha256: kept.payloadSha256, failureOccurrences: kept.failureOccurrences })
      .toEqual({ payload: before!.payload, payloadSha256: before!.payloadSha256, failureOccurrences: before!.failureOccurrences });
    const correctionId = `tpc_${winner.correctionSha256}`;
    await repository.noteProvenanceCorrectionAttempt(correctionId);
    expect((await repository.pendingProvenanceCorrections(10)).find(item => item.correctionId === correctionId)?.delivery)
      .toMatchObject({ state: "pending", lastAttemptAt: expect.any(String) });
    await expect(new TestRunService().acknowledgeProvenanceCorrection(correctionId, "other_run")).rejects.toMatchObject({ status: 409 });
    await new TestRunService().acknowledgeProvenanceCorrection(correctionId, "anchor_run");
    await new TestRunService().acknowledgeProvenanceCorrection(correctionId, "anchor_run");
    await new TestRunService().refuseProvenanceCorrection(correctionId); // Settled receipts never change.
    const packet = await new TestRunService().failureDetail(id);
    expect(packet).toMatchObject({ sourceStatus: "corrected", source: request("x").source, delivery: { state: "acknowledged", agentRunId: "anchor_run" },
      provenanceCorrection: { correctionId, delivery: { state: "acknowledged" } }, failure: { assetIds: ["gate-video"] } });
    // An exact replay of the accepted result leaves the correction and receipts untouched.
    const settled = (await TestRunModel.findOne({ runId: run.runId }).lean())!;
    await new TestRunService().ingest(run);
    const replayed = (await TestRunModel.findOne({ runId: run.runId }).lean())!;
    expect({ corrections: replayed.provenanceCorrections, occurrences: replayed.failureOccurrences, payload: replayed.payload })
      .toEqual({ corrections: settled.provenanceCorrections, occurrences: settled.failureOccurrences, payload: before!.payload });
  });
});
