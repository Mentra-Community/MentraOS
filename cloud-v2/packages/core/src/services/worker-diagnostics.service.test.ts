import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createTestRunIngestApi } from "../api/internal/test-runs.api";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import { TestRunModel, TestAssetModel } from "../models/test-run.model";
import { ReportModel } from "../models/report.model";
import { ReportAssetModel } from "../models/report-asset.model";
import { signTestFailureReadGrant, signWorkerDiagnosticsGrant, verifyTestFailureReadGrant } from "./test-failure-auth";
import { WorkerDiagnosticsService } from "./worker-diagnostics.service";
import { TestRunService } from "./test-run.service";
import { getReport, submitReport } from "./report.service";
import { TestFailureIncidentService } from "./test-failure-incident.service";
import { StorageService } from "./storage/storage.service";
import type { TestRun } from "../types/test-run.types";

const secret = "synthetic-diagnostic-signing-" + "x".repeat(32);
const ingestToken = "synthetic-ingest-" + "y".repeat(32);
const occurrenceId = `tfo_${"a".repeat(64)}`;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const body = (payloadSha256 = "d".repeat(64), attachmentKey = "attempt-1") => ({ schemaVersion: 1,
  payloadSha256, attachmentKey, entries: [{ timestamp: 123456789, level: "error", message: "Recorder exited before completion." }] });
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const grant = (id = occurrenceId, environment: "dev" | "staging" = "dev", expires = Math.floor(Date.now() / 1000) + 600) =>
  signWorkerDiagnosticsGrant({ purpose: "mentra-test-failure-diagnostics-v1", environment, occurrenceId: id, expires }, secret);

describe("worker diagnostics route authority", () => {
  const previous = { ingest: process.env.TEST_RUN_INGEST_TOKEN, signing: process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET,
    environment: process.env.CLOUD_CORE_ENVIRONMENT };
  beforeEach(() => {
    process.env.TEST_RUN_INGEST_TOKEN = ingestToken;
    process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret;
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  });
  afterEach(() => {
    for (const [key, value] of Object.entries({ TEST_RUN_INGEST_TOKEN: previous.ingest,
      CLOUD_REPORT_AGENT_SIGNING_SECRET: previous.signing, CLOUD_CORE_ENVIRONMENT: previous.environment }))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  test("ingest route accepts only its existing credential and exact run selector", async () => {
    const calls: unknown[] = [];
    const app = createTestRunIngestApi(undefined, { forRun: async (id, input) => {
      calls.push([id, input]); return { stored: true } as never;
    } });
    expect((await app.request("/run-1/diagnostics", { method: "POST", headers: headers("wrong"), body: JSON.stringify(body()) })).status).toBe(401);
    const response = await app.request("/run-1/diagnostics", { method: "POST", headers: headers(ingestToken), body: JSON.stringify(body()) });
    expect(response.status).toBe(200);
    expect(calls).toEqual([["run-1", body()]]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  test("read/other occurrence/environment/expired grants cannot write; diagnostics cannot read", async () => {
    let calls = 0;
    const app = createTestFailureAgentApi(undefined, undefined, undefined, undefined, undefined, undefined,
      { forOccurrence: async id => { expect(id).toBe(occurrenceId); calls++; return { stored: true } as never; } });
    const read = signTestFailureReadGrant(occurrenceId, "dev", Math.floor(Date.now() / 1000) + 600, secret);
    for (const token of [read, ingestToken, grant(`tfo_${"b".repeat(64)}`), grant(occurrenceId, "staging"),
      grant(occurrenceId, "dev", Math.floor(Date.now() / 1000) - 1), grant() + "0"])
      expect((await app.request(`/${occurrenceId}/diagnostics`, { method: "POST", headers: headers(token), body: JSON.stringify(body()) })).status).toBe(401);
    expect(calls).toBe(0);
    expect((await app.request(`/${occurrenceId}/diagnostics`, { method: "POST", headers: headers(grant()), body: JSON.stringify(body()) })).status).toBe(200);
    expect(calls).toBe(1);
    expect(verifyTestFailureReadGrant(grant(), occurrenceId, secret, "dev")).toBe(false);
    expect((await app.request(`/${occurrenceId}`, { headers: headers(grant()) })).status).toBe(401);
  });
  test("malformed and oversized bodies never reach the writer", async () => {
    let calls = 0;
    const app = createTestRunIngestApi(undefined, { forRun: async () => { calls++; return {} as never; } });
    for (const [payload, status] of [["{", 400], ["x".repeat(1024 * 1024 + 1), 413]] as const)
      expect((await app.request("/run-1/diagnostics", { method: "POST", headers: headers(ingestToken), body: payload })).status).toBe(status);
    expect(calls).toBe(0);
  });
});

// Real unique indexes and conditional bindings, opt-in loopback DB; never a production database.
const uri = process.env.TEST_WORKER_DIAGNOSTICS_MONGO_URI;
describe.skipIf(!uri)("worker diagnostics report persistence", () => {
  let connected = false;
  const objects = new Map<string, Uint8Array>();
  let failure: "put" | "receipt" | "readback" | null = null;
  let writes = 0;
  const storage = new StorageService({
    async putObject(input) {
      writes++;
      if (failure === "put") throw new Error("synthetic credential must not escape: bearer-private");
      objects.set(input.key, input.body.slice());
      return { key: input.key, contentType: input.contentType, sizeBytes: input.body.byteLength,
        sha256: failure === "receipt" ? "0".repeat(64) : digest(input.body) };
    },
    async getObject(key) { return failure === "readback" ? new Uint8Array() : objects.get(key)!; },
    async deleteObject(key) { objects.delete(key); },
    async putFile() { throw new Error("unused"); }, async statObject() { throw new Error("unused"); },
    async streamObject() { throw new Error("unused"); },
  });
  const runs = new TestRunService(undefined, () => storage), diagnostics = new WorkerDiagnosticsService(storage);
  const fixture = (id: string, incidentIds: string[] = []): TestRun => ({
    runId: id, requestId: `request-${id}`, routineId: "example", routineVersion: "1", platform: "android", channel: "local",
    startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:01:00Z", outcome: "failed",
    outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "incomplete" },
    provenance: { repository: "Mentra-Community/MentraOS" }, fixture: { alias: "synthetic-phone" },
    firmwareAssertions: [], chapters: [], assets: [], failures: [{ phase: "test", step: null, code: "recording-failed",
      message: "Recorder failed", assetIds: [], incidentIds, redactionPolicy: "synthetic-v1",
      missingEvidence: [{ kind: "recording", reason: "Recorder failed" }] }],
  });
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("diagnostic tests require plain loopback Mongo URL");
    url.pathname = `/test_worker_diagnostics_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5000 }); connected = true;
    await Promise.all([TestRunModel, TestAssetModel, ReportModel, ReportAssetModel].map(model => model.createIndexes()));
  });
  afterAll(async () => { if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
  beforeEach(() => { failure = null; });

  test("concurrent retries create one incident and one attachment, expose its existing reader, preserve failed payload", async () => {
    const original = fixture("concurrent"), accepted = await runs.ingest(original);
    const input = body(accepted.payloadSha256);
    const results = await Promise.all(Array.from({ length: 10 }, () => diagnostics.forRun(original.runId, input)));
    expect(new Set(results.map(result => JSON.stringify(result))).size).toBe(1);
    const receipt = results[0]!;
    expect(receipt.sha256).toBe(digest(JSON.stringify({ entries: input.entries })));
    expect(receipt.sizeBytes).toBe(Buffer.byteLength(JSON.stringify({ entries: input.entries })));
    expect(await ReportModel.countDocuments({ "context.testRunId": original.runId })).toBe(1);
    expect(await ReportAssetModel.countDocuments({ reportId: receipt.reportId })).toBe(1);
    const report = await getReport(receipt.reportId);
    expect(report?.report.artifacts).toHaveLength(1);
    expect(report?.report.status).toBe("ready");
    const saved = await TestRunModel.findOne({ runId: original.runId }).lean();
    expect(saved?.payload).toEqual(original);
    expect(saved?.payloadSha256).toBe(accepted.payloadSha256);
    expect(saved?.failureOccurrences?.[0].failure.incidentIds).toEqual([]);
    const detail = await runs.failureDetail(accepted.occurrenceIds[0]!);
    expect(detail.failure.incidentIds).toEqual([receipt.reportId]);
    expect(detail.originalOutcome).toBe("failed");
    expect(detail.evidence.complete).toBe(false);
    const reader = new TestFailureIncidentService(runs, { getReport, readReportArtifactPayload: async (id, assetId) => {
      const asset = await ReportAssetModel.findOne({ reportId: id, artifactId: assetId }).lean();
      return asset ? { bytes: objects.get(asset.storageKey)!, contentType: asset.contentType, fileName: null } as never : null;
    } });
    const incident = await reader.metadata(accepted.occurrenceIds[0]!, receipt.reportId, "/diagnostics");
    expect(incident.availability).toBe("found");
    expect(incident.logs.state).toBe("usable");
    const later = await diagnostics.forOccurrence(accepted.occurrenceIds[0]!, body(accepted.payloadSha256, "fixer-1"));
    expect(later.reportId).toBe(receipt.reportId);
    expect(later.artifactId).not.toBe(receipt.artifactId);
    expect((await getReport(receipt.reportId))?.report.artifacts).toHaveLength(2);
  });
  test("a racing different body cannot overwrite a reserved attachment", async () => {
    const accepted = await runs.ingest(fixture("conflict")), input = body(accepted.payloadSha256);
    const other = { ...input, entries: [{ ...input.entries[0]!, message: "Different diagnostic" }] };
    const results = await Promise.allSettled([diagnostics.forRun("conflict", input), diagnostics.forRun("conflict", other)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")[0]).toMatchObject({ reason: { status: 409 } });
    const row = await TestRunModel.findOne({ runId: "conflict" }).lean();
    const assets = await ReportAssetModel.find({ reportId: row!.diagnosticsReportId }).lean();
    expect(assets).toHaveLength(1);
    expect(digest(objects.get(assets[0]!.storageKey)!)).toBe(assets[0]!.sha256);
  });
  test("failed writes, false storage receipts and corrupt readback never ACK; identical retries finish one reservation", async () => {
    for (const mode of ["put", "receipt", "readback"] as const) {
      const accepted = await runs.ingest(fixture(`failed-${mode}`)), input = body(accepted.payloadSha256);
      failure = mode;
      await expect(diagnostics.forRun(`failed-${mode}`, input)).rejects.toMatchObject({ status: 503 });
      const row = await TestRunModel.findOne({ runId: `failed-${mode}` }).lean();
      expect((await getReport(row!.diagnosticsReportId!))?.report.artifacts).toHaveLength(0);
      failure = null;
      const receipt = await diagnostics.forRun(`failed-${mode}`, input);
      expect(receipt.stored).toBe(true);
      expect(await ReportAssetModel.countDocuments({ reportId: receipt.reportId })).toBe(1);
    }
  });
  test("first recorded report is reused across multiple incidents without completing original collection", async () => {
    const existing = await submitReport({ mentraUserId: "mu_original", kind: "automatic",
      trigger: { type: "automatic", source: "test", reason: "original" }, report: { actualBehavior: "Original failure" }, context: {} });
    const accepted = await runs.ingest(fixture("existing", [existing.reportId, "rep_second"]));
    const receipt = await diagnostics.forRun("existing", body(accepted.payloadSha256));
    expect(receipt.reportId).toBe(existing.reportId);
    expect((await getReport(existing.reportId))?.report).toMatchObject({ mentraUserId: "mu_original", status: "collecting" });
    await ReportModel.updateOne({ reportId: existing.reportId }, { $set: { status: "closed" } });
    await diagnostics.forRun("existing", body(accepted.payloadSha256, "later"));
    expect((await getReport(existing.reportId))?.report.status).toBe("closed");
    expect(await ReportModel.countDocuments({ "context.testRunId": "existing" })).toBe(0);
  });
  test("unknown/mismatched/incomplete runs and invented report/owner refuse before blob writes", async () => {
    const accepted = await runs.ingest(fixture("refuse")), before = writes;
    await expect(diagnostics.forRun("missing", body())).rejects.toMatchObject({ status: 404 });
    await expect(diagnostics.forOccurrence(`tfo_${"f".repeat(64)}`, body())).rejects.toMatchObject({ status: 404 });
    await expect(diagnostics.forRun("refuse", body())).rejects.toMatchObject({ status: 409 });
    for (const extra of [{ reportId: "rep_rogue" }, { mentraUserId: "mu_other" }, { path: "/private/path" }])
      await expect(diagnostics.forRun("refuse", { ...body(accepted.payloadSha256), ...extra })).rejects.toMatchObject({ status: 400 });
    await TestRunModel.updateOne({ runId: "refuse" }, { $set: { uploadsComplete: false } });
    await expect(diagnostics.forRun("refuse", body(accepted.payloadSha256))).rejects.toMatchObject({ status: 409 });
    expect(writes).toBe(before);
  });
});
