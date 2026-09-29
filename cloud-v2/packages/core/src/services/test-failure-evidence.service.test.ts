import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import { evidenceSupplementManifestSchema, type EvidenceSupplement, type EvidenceSupplementRequest, type EvidenceSupplementReference } from "../types/test-failure-evidence.types";
import { TestFailureEvidenceService, type EvidenceSupplementRepository } from "./test-failure-evidence.service";
import { canonical, type StoredTestAsset, type StoredTestRun, type TestRunService } from "./test-run.service";
import { StorageService } from "./storage/storage.service";
import { LocalStorageProvider } from "./storage/providers/local-storage.provider";
import { signTestFailureReadGrant, signTestFailureEvidenceDelivery, signTestFailureCorrectionDelivery } from "./test-failure-auth";
import { TestFailureDeliveryService } from "./test-failure-delivery.service";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const occurrenceId = `tfo_${"a".repeat(64)}`, agentRunId = "11111111-1111-4111-8111-111111111111", runId = "synthetic-preparation";
const secret = "synthetic-signing-secret-" + "x".repeat(40);
class MemorySupplements implements EvidenceSupplementRepository {
  values: EvidenceSupplement[] = [];
  beforeAppend?: () => void;
  async list() { return structuredClone(this.values); }
  async append(value: EvidenceSupplement) {
    this.beforeAppend?.();
    if (stored.payloadSha256 !== value.reference.payloadSha256 || stored.failureOccurrences![0]!.delivery.state !== "acknowledged") return;
    if (this.values.length < 2 && !this.values.some(item => item.reference.target.caseRevision === value.reference.target.caseRevision
      && item.reference.target.sessionSha256 === value.reference.target.sessionSha256)) this.values.push(structuredClone(value));
  }
  async pending(limit: number) { return structuredClone(this.values.filter(item => item.delivery.state === "pending").slice(0, limit)); }
  async attempted(id: string) { const item = this.values.find(item => item.reference.supplementId === id); if (item?.delivery.state === "pending") item.delivery.lastAttemptAt = new Date().toISOString(); }
  async settle(id: string, value: Exclude<EvidenceSupplement["delivery"], { state: "pending" }>) {
    const item = this.values.find(item => item.reference.supplementId === id);
    if (item?.delivery.state === "pending" && (value.state === "refused" || value.agentRunId === item.reference.agentRunId)) item.delivery = value;
  }
}
let directory: string, stored: StoredTestRun, supplements: MemorySupplements, service: TestFailureEvidenceService;
let objects: StoredTestAsset[], storage: StorageService, previousEnvironment: string | undefined;
const request = (caseRevision = 7): EvidenceSupplementRequest => {
  const json = '{"source":"synthetic-native-capture","lines":["apply acknowledged"],"continuousCoverage":false}\n';
  return { confirmation: "append-reviewed-diagnostics", manifest: { schemaVersion: 1, environment: "dev", testRunId: runId,
    payloadSha256: stored.payloadSha256, occurrenceId, revision: 1, agentRunId,
    target: { caseId: `mfc_${"b".repeat(64)}`, caseRevision, sessionSha256: "c".repeat(64) },
    reason: "Supply the retained bounded native capture for the existing evidence stop.", redactionPolicy: "reviewed-harness-diagnostic-v1",
    assets: [{ assetId: "native-capture", sizeBytes: Buffer.byteLength(json), sha256: hash(json) }] },
    content: [{ assetId: "native-capture", json }] };
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "failure-evidence-test-"));
  previousEnvironment = process.env.CLOUD_CORE_ENVIRONMENT; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  // The accepted source/result are deliberately unchanged and never re-ingested by this feature.
  stored = { run: { runId, source: { repository: "Mentra-Community/Mentra-Automated-Testing", headSha: "d".repeat(40) },
    outcome: "failed", assets: [], outcomes: { test: "not-run", fixture: "unknown", evidence: "incomplete" } } as unknown as StoredTestRun["run"],
    payloadSha256: "e".repeat(64), failureOccurrences: [{ occurrenceId, revision: 1,
      failure: { phase: "setup", step: { id: "bes-install" }, assetIds: [], incidentIds: [] },
      delivery: { state: "acknowledged", agentRunId, acknowledgedAt: "2026-09-29T10:00:00Z" } } as never] };
  supplements = new MemorySupplements(); objects = [];
  storage = new StorageService(new LocalStorageProvider({ rootDir: directory }));
  service = new TestFailureEvidenceService({ get: async id => id === runId ? stored : null,
    failure: async id => id === occurrenceId ? stored : null, assets: async () => objects,
    insertAsset: async asset => { const previous = objects.find(item => item.assetId === asset.assetId); if (previous) return previous; objects.push(asset); return asset; },
  }, supplements, () => storage);
});
afterEach(async () => {
  if (previousEnvironment === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT; else process.env.CLOUD_CORE_ENVIRONMENT = previousEnvironment;
  await rm(directory, { recursive: true, force: true });
});

test("reviewed JSON is separately assigned, digest-bound and replayable without changing the accepted result", async () => {
  const original = structuredClone(stored), input = request();
  const first = await service.submit(runId, occurrenceId, input, "synthetic-reviewer");
  expect(first.created).toBe(true);
  expect(stored).toEqual(original);
  const r = first.supplement.reference;
  expect(r.supplementSha256).toBe(hash(canonical(input.manifest)));
  expect(await service.submit(runId, occurrenceId, input, "synthetic-reviewer")).toMatchObject({ created: false });
  expect(supplements.values).toHaveLength(1); expect(objects).toHaveLength(1);
  const packet = await service.metadata(occurrenceId, r.supplementId);
  expect(packet.reference).toEqual(r); expect(packet.manifest).toEqual(input.manifest);
  expect(JSON.stringify(packet)).not.toContain("storageKey");
  const response = await service.media(occurrenceId, r.supplementId, "native-capture", new Request("https://core.invalid"));
  expect(await response.text()).toBe(input.content[0]!.json);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await service.media(occurrenceId, r.supplementId, "native-capture", new Request("https://core.invalid", { method: "HEAD" }))).body).toBeNull();
});

test("wrong immutable bindings and malformed or changed bytes refuse before storage", async () => {
  for (const corrupt of [
    (r: any) => { r.manifest.testRunId = "another-run"; }, (r: any) => { r.manifest.occurrenceId = `tfo_${"f".repeat(64)}`; },
    (r: any) => { r.manifest.payloadSha256 = "f".repeat(64); }, (r: any) => { r.manifest.agentRunId = "22222222-2222-4222-8222-222222222222"; },
    (r: any) => { r.manifest.environment = "prod"; }, (r: any) => { r.manifest.revision = 2; },
    (r: any) => { r.manifest.redactionPolicy = "not-reviewed"; }, (r: any) => { r.confirmation = "automatic"; },
    (r: any) => { r.content[0].json += " "; }, (r: any) => { r.content[0].assetId = "unassigned"; },
    (r: any) => { r.content.push(r.content[0]); }, (r: any) => { r.manifest.assets[0].sizeBytes = 262145; },
    (r: any) => { r.manifest.target.caseRevision = -1; }, (r: any) => { r.manifest.target.sessionSha256 = "invalid"; },
  ]) {
    const input = request(); corrupt(input);
    await expect(service.submit(runId, occurrenceId, input, "reviewer")).rejects.toBeDefined();
    expect(objects).toHaveLength(0); expect(supplements.values).toHaveLength(0);
  }
  const badJson = request(); badJson.content[0]!.json = "not json";
  badJson.manifest.assets[0]!.sizeBytes = 8; badJson.manifest.assets[0]!.sha256 = hash("not json");
  await expect(service.submit(runId, occurrenceId, badJson, "reviewer")).rejects.toThrow("not JSON");
});

test("an interrupted append publishes nothing and retry reuses the exact already-stored object", async () => {
  supplements.beforeAppend = () => { throw new Error("synthetic DB reply lost"); };
  const input = request();
  await expect(service.submit(runId, occurrenceId, input, "reviewer")).rejects.toThrow("reply lost");
  expect(objects).toHaveLength(1); expect(supplements.values).toHaveLength(0);
  await expect(service.metadata(occurrenceId, `tes_${hash(canonical(input.manifest))}`)).rejects.toThrow("not assigned");
  supplements.beforeAppend = undefined;
  expect((await service.submit(runId, occurrenceId, input, "reviewer")).created).toBe(true);
  expect(objects).toHaveLength(1);
});

test("a changed stop or a third supplement cannot append, and aggregate byte limits stay bounded", async () => {
  await service.submit(runId, occurrenceId, request(), "reviewer");
  const changed = request(); changed.manifest.reason = "A different statement for the already supplied exact stop.";
  await expect(service.submit(runId, occurrenceId, changed, "reviewer")).rejects.toThrow("already has");
  await service.submit(runId, occurrenceId, request(8), "reviewer");
  await expect(service.submit(runId, occurrenceId, request(9), "reviewer")).rejects.toThrow("bound");
  expect(supplements.values).toHaveLength(2);
  expect(evidenceSupplementManifestSchema.safeParse({ ...request().manifest, assets: Array(9).fill(request().manifest.assets[0]) }).success).toBe(false);
  expect(evidenceSupplementManifestSchema.safeParse({ ...request().manifest,
    assets: ["first", "second"].map(assetId => ({ assetId, sizeBytes: 131073, sha256: "a".repeat(64) })) }).success).toBe(false);
});

test("a changed accepted payload at append refuses instead of publishing uploaded diagnostics", async () => {
  const input = request(); supplements.beforeAppend = () => { stored.payloadSha256 = "f".repeat(64); };
  await expect(service.submit(runId, occurrenceId, input, "reviewer")).rejects.toThrow("target changed");
  expect(supplements.values).toHaveLength(0);
});

test("asset paths stay occurrence-scoped and altered stored bytes fail refresh", async () => {
  const { supplement: { reference: r } } = await service.submit(runId, occurrenceId, request(), "reviewer");
  await expect(service.metadata(`tfo_${"f".repeat(64)}`, r.supplementId)).rejects.toThrow("not assigned");
  await expect(service.media(occurrenceId, r.supplementId, "../native-capture", new Request("https://core.invalid"))).rejects.toThrow("not assigned");
  await storage.putObject({ key: objects[0]!.storageKey, body: Buffer.from("{}"), contentType: "application/json" });
  await expect(service.media(occurrenceId, r.supplementId, "native-capture", new Request("https://core.invalid"))).rejects.toThrow("bytes differ");
  expect(stored.run.outcome).toBe("failed");
});

test("stored reference/manifest disagreement never broadens a diagnostic read", async () => {
  const { supplement: { reference: ref } } = await service.submit(runId, occurrenceId, request(), "reviewer");
  supplements.values[0]!.reference.target.caseRevision++;
  await expect(service.metadata(occurrenceId, ref.supplementId)).rejects.toThrow("manifest differs");
});

test("an authenticated controller refusal stays terminal and revokes supplemental reads without altering the failure", async () => {
  const original = structuredClone(stored), { supplement: { reference: ref } } = await service.submit(runId, occurrenceId, request(), "reviewer");
  await supplements.settle(ref.supplementId, { state: "refused", refusedAt: new Date().toISOString() });
  expect(await supplements.pending(10)).toEqual([]);
  await expect(service.metadata(occurrenceId, ref.supplementId)).rejects.toThrow("not assigned");
  expect(stored).toEqual(original);
});

test("admin review and existing occurrence read capabilities are required at the HTTP boundary", async () => {
  const admin = new Hono<any>();
  admin.use("*", async (c, next) => { if (c.req.header("x-test-admin") === "yes") { c.set("isAdmin", true); c.set("developer", { developerId: "reviewer" }); } await next(); });
  admin.route("/", createTestRunAdminApi(undefined, undefined, undefined, undefined, undefined, service));
  const path = `/${runId}/failures/${occurrenceId}/evidence-supplements`;
  const send = (headers: Record<string, string>) => admin.request(path, { method: "POST", headers, body: JSON.stringify(request()) });
  expect((await send({ "content-type": "application/json" })).status).toBe(403);
  expect((await send({ "x-test-admin": "yes", "content-type": "text/plain" })).status).toBe(400);
  const posted = await send({ "x-test-admin": "yes", "content-type": "application/json" }); expect(posted.status).toBe(201);
  const r = (await posted.json() as { reference: EvidenceSupplementReference }).reference;
  const api = createTestFailureAgentApi(undefined, undefined, undefined, undefined, undefined, service);
  const route = `/${occurrenceId}/evidence-supplements/${r.supplementId}`;
  const oldSecret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET; process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret;
  try {
    expect((await api.request(route)).status).toBe(401);
    const token = signTestFailureReadGrant(occurrenceId, "dev", Math.floor(Date.now() / 1000) + 60, secret);
    expect((await api.request(route, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await api.request(route, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await api.request(route.replace(occurrenceId, `tfo_${"f".repeat(64)}`), { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  } finally { if (oldSecret === undefined) delete process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET; else process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = oldSecret; }
});

test("normal delivery sends only the signed reference and authenticates the existing anchor acknowledgement", async () => {
  const { supplement: { reference: ref } } = await service.submit(runId, occurrenceId, request(), "reviewer");
  const previous = [process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET, process.env.CLOUD_REPORT_AGENT_URL];
  process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_REPORT_AGENT_URL = "https://agent.invalid";
  const calls: string[] = []; let correct = false;
  const sender = (async (url: URL, options: RequestInit) => {
    expect(url.pathname).toBe("/internal/routine-failure-evidence-supplements");
    const body = String(options.body), headers = new Headers(options.headers), expires = Number(headers.get("x-mentra-action-expires"));
    expect(JSON.parse(body)).toEqual(ref); expect(body).not.toContain("apply acknowledged"); calls.push(body);
    expect(headers.get("x-mentra-action-signature")).toBe(signTestFailureEvidenceDelivery(body, expires, secret));
    expect(signTestFailureEvidenceDelivery(body, expires, secret)).not.toBe(signTestFailureCorrectionDelivery(body, expires, secret));
    return Response.json({ schemaVersion: 1, occurrenceId, revision: 1, agentRunId: correct ? agentRunId : "22222222-2222-4222-8222-222222222222",
      supplementId: ref.supplementId, status: "accepted" });
  }) as typeof fetch;
  const runs = { pendingFailureDeliveries: async () => [], pendingProvenanceCorrectionDeliveries: async () => [] } as unknown as TestRunService;
  try {
    const delivery = new TestFailureDeliveryService(runs, sender, service);
    expect((await delivery.flush()).evidenceSupplements?.acknowledged).toBe(0);
    expect(supplements.values[0]!.delivery.state).toBe("pending"); correct = true;
    expect((await delivery.flush()).evidenceSupplements?.acknowledged).toBe(1);
    expect((await delivery.flush()).evidenceSupplements).toBeUndefined(); expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
  } finally {
    for (const [index, key] of ["CLOUD_REPORT_AGENT_SIGNING_SECRET", "CLOUD_REPORT_AGENT_URL"].entries())
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }
});
