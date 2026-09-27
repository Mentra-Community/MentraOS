import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import { createTestRunIngestApi } from "../api/internal/test-runs.api";
import { adminAuth } from "../api/middleware/admin-auth.middleware";
import { TestRunModel } from "../models/test-run.model";
import { signTestFailureCorrectionDelivery, signTestFailureDelivery, signTestFailureReadGrant } from "./test-failure-auth";
import { TestFailureCorrectionService } from "./test-failure-correction.service";
import { testFailureSchema, type TestFailureProvenanceCorrection } from "../types/test-failure.types";
import { createTestFailureOccurrences } from "./test-failure-occurrence";
import { TestFailureDeliveryService, startTestFailureDelivery } from "./test-failure-delivery.service";
import { testRunQuerySchema, testRunSchema, type TestRun, type TestRunQuery } from "../types/test-run.types";
import { StorageService } from "./storage/storage.service";
import { LocalStorageProvider } from "./storage/providers/local-storage.provider";
import { S3StorageProvider } from "./storage/providers/s3-storage.provider";
import { MongoTestRunRepository, parseTestAssetRange, TestRunService, type StoredTestAsset, type StoredTestRun, type TestRunRepository } from "./test-run.service";

class MemoryRepository implements TestRunRepository {
  runs = new Map<string, StoredTestRun>();
  objects = new Map<string, StoredTestAsset>();
  outcomes = new Map<string, TestRun["outcome"]>();
  async get(id: string) { return this.runs.get(id) ?? null; }
  async insert(run: TestRun, payloadSha256: string) {
    const stored = this.runs.get(run.runId);
    if (stored) return { stored, created: false };
    const value = structuredClone({ run, payloadSha256, failureOccurrences: createTestFailureOccurrences(run) });
    this.runs.set(run.runId, value);
    this.outcomes.set(run.runId, run.outcome === "passed" && run.assets.length ? "blocked" : run.outcome);
    return { stored: value, created: true };
  }
  async list(query: TestRunQuery) { return [...this.runs.values()].filter(row =>
    (!query.outcome || this.outcomes.get(row.run.runId) === query.outcome)
    && (!query.occurrenceId || row.failureOccurrences?.some(item => item.occurrenceId === query.occurrenceId))); }
  async assets(runId: string) { return [...this.objects.values()].filter(asset => asset.runId === runId); }
  async insertAsset(asset: StoredTestAsset) {
    const key = `${asset.runId}/${asset.assetId}`;
    if (!this.objects.has(key)) this.objects.set(key, asset);
    return this.objects.get(key)!;
  }
  async markUploadsComplete(run: TestRun) { this.outcomes.set(run.runId, run.outcome); }
  async reconcileFailures(stored: StoredTestRun) {
    stored.failureOccurrences ??= createTestFailureOccurrences(stored.run);
    return stored;
  }
  async failure(id: string) { return [...this.runs.values()].find(row => row.failureOccurrences?.some(item => item.occurrenceId === id)) ?? null; }
  async pendingFailures(limit: number) {
    return [...this.runs.values()].flatMap(row => (row.failureOccurrences ?? []).filter(item => item.delivery.state === "pending")
      .map(item => ({ ...row, failureOccurrences: [item] }))).slice(0, limit);
  }
  async noteFailureDeliveryAttempt(id: string) {
    const delivery = (await this.failure(id))?.failureOccurrences?.find(item => item.occurrenceId === id)?.delivery;
    if (delivery?.state === "pending") delivery.lastAttemptAt = new Date().toISOString();
  }
  async acknowledgeFailure(id: string, agentRunId: string) {
    const occurrence = (await this.failure(id))?.failureOccurrences?.find(item => item.occurrenceId === id);
    if (!occurrence || (occurrence.delivery.state === "acknowledged" && occurrence.delivery.agentRunId !== agentRunId)) throw new Error("different delivery receipt");
    if (occurrence.delivery.state === "pending") occurrence.delivery = { state: "acknowledged", agentRunId, acknowledgedAt: new Date().toISOString() };
  }
  // Same guards as the Mongo conditional $push: exact payload, missing source, acknowledged anchor, one per occurrence.
  async addProvenanceCorrection(correction: TestFailureProvenanceCorrection) {
    const row = this.runs.get(correction.runId);
    const occurrence = row?.failureOccurrences?.find(item => item.occurrenceId === correction.occurrenceId);
    if (row && row.payloadSha256 === correction.payloadSha256 && !row.run.source && occurrence?.revision === correction.occurrenceRevision
      && occurrence.delivery.state === "acknowledged" && occurrence.delivery.agentRunId === correction.agentRunId
      && !row.provenanceCorrections?.some(item => item.occurrenceId === correction.occurrenceId))
      (row.provenanceCorrections ??= []).push(structuredClone(correction));
    return row ?? null;
  }
  private correction(id: string) { return [...this.runs.values()].flatMap(row => row.provenanceCorrections ?? []).find(item => item.correctionId === id); }
  async pendingProvenanceCorrections(limit: number) {
    return [...this.runs.values()].flatMap(row => row.provenanceCorrections ?? []).filter(item => item.delivery.state === "pending")
      .map(item => structuredClone(item)).slice(0, limit);
  }
  async noteProvenanceCorrectionAttempt(id: string) {
    const correction = this.correction(id);
    if (correction?.delivery.state === "pending") correction.delivery.lastAttemptAt = new Date().toISOString();
  }
  async settleProvenanceCorrection(id: string, delivery: Extract<TestFailureProvenanceCorrection["delivery"], { state: "acknowledged" | "refused" }>) {
    const correction = this.correction(id);
    if (correction?.delivery.state === "pending" && (delivery.state === "refused" || delivery.agentRunId === correction.agentRunId)) correction.delivery = delivery;
    return correction ? structuredClone(correction) : null;
  }
}

const TOKEN = "test-worker-token-" + "x".repeat(32);
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom00000000000000000000")]);
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const fixture = (): TestRun => ({
  runId: "run-example-1", requestId: "request-ci-1", routineId: "mac-smoke", routineVersion: "1",
  platform: "ios-mac", channel: "pr", prNumber: 123,
  startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:10:00Z", outcome: "passed",
  outcomes: { test: "passed", teardown: "passed", fixture: "ready", evidence: "complete" },
  provenance: { repository: "Mentra-Community/MentraOS", buildSha: "a".repeat(40), manifestSha256: "b".repeat(64) },
  fixture: { alias: "lab-03be" }, firmwareAssertions: [{ component: "BES", expected: "26.9.21.1", actual: "26.9.21.1", status: "passed" }],
  chapters: [{ id: "step-1", instruction: "Open the Mentra App", phase: "test", status: "passed", videoAssetId: "video-1", videoStart: 2 }],
  assets: [{ assetId: "video-1", kind: "video", contentType: "video/mp4", filename: "run.mp4", sizeBytes: video.length, sha256: sha256(video) }],
});

let root: string;
let previousToken: string | undefined;
let repository: MemoryRepository;
let service: TestRunService;
let ingest: ReturnType<typeof createTestRunIngestApi>;
let admin: ReturnType<typeof createTestRunAdminApi>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "test-run-service-test-"));
  previousToken = process.env.TEST_RUN_INGEST_TOKEN;
  process.env.TEST_RUN_INGEST_TOKEN = TOKEN;
  repository = new MemoryRepository();
  const provider = new LocalStorageProvider({ rootDir: root });
  provider.getObject = async () => { throw new Error("whole-object reads are forbidden for media"); };
  service = new TestRunService(repository, () => new StorageService(provider));
  ingest = createTestRunIngestApi(service);
  admin = createTestRunAdminApi(service);
});
afterEach(async () => {
  if (previousToken === undefined) delete process.env.TEST_RUN_INGEST_TOKEN;
  else process.env.TEST_RUN_INGEST_TOKEN = previousToken;
  await rm(root, { recursive: true, force: true });
});
const post = (run: unknown = fixture(), token = TOKEN) => ingest.request("/", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(run),
});
const put = (bytes: Uint8Array = video, id = "video-1") => ingest.request(`/run-example-1/assets/${id}`, {
  method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "video/mp4" }, body: bytes,
});

test("history and detail show the export's release identity without rewriting its immutable payload", async () => {
  const run = fixture(); run.provenance.releaseIdentity = "3.3.0-dev.351";
  await service.ingest(run);
  expect((await service.detail(run.runId)).release).toBe("3.3.0-dev.351");
  expect((await service.list({ limit: 25 })).runs[0]?.release).toBe("3.3.0-dev.351");
  expect(repository.runs.get(run.runId)?.run.release).toBeUndefined();
});

test("build-scoped list links reach Mongo as exact provenance filters and reject malformed hashes", async () => {
  const query = {repository: "Mentra-Community/MentraOS", pr: "4136", headSha: "a".repeat(40),
    archiveSha256: "b".repeat(64), routineId: "day1-ota", platform: "ios-mac", channel: "pr"};
  const find = spyOn(TestRunModel, "find").mockReturnValue({sort: () => ({limit: () => ({lean: async () => []})})} as unknown as ReturnType<typeof TestRunModel.find>);
  try {
    const api = createTestRunAdminApi(new TestRunService(new MongoTestRunRepository()));
    const response = await api.request(`/?${new URLSearchParams(query)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({runs: [], nextCursor: null});
    expect(find).toHaveBeenCalledWith({
      "payload.prNumber": 4136, "payload.channel": "pr", "payload.routineId": "day1-ota", "payload.platform": "ios-mac",
      "payload.provenance.repository": query.repository, "payload.provenance.headSha": query.headSha,
      "payload.provenance.archiveSha256": query.archiveSha256,
    });
    for (const patch of [{repository: "../repo"}, {headSha: "short"}, {archiveSha256: "short"}])
      expect((await api.request(`/?${new URLSearchParams({...query, ...patch})}`)).status).toBe(400);
    expect(find).toHaveBeenCalledTimes(1);
  } finally { find.mockRestore(); }
});

describe("test run authentication and immutable ingestion", () => {
  test("fails closed before parsing bodies and does not grant admin access to the worker token", async () => {
    expect((await post({}, "wrong")).status).toBe(401);
    expect(repository.runs.size).toBe(0);
    delete process.env.TEST_RUN_INGEST_TOKEN;
    expect((await post()).status).toBe(503);
    const gated = new Hono();
    gated.use("*", adminAuth);
    gated.route("/", admin);
    expect((await gated.request("/", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    expect((await gated.request("/run-example-1/assets/video-1", { method: "HEAD" })).status).toBe(401);
  });
  test("replays identical metadata but rejects changed provenance or outcomes", async () => {
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(200);
    const changed = fixture(); changed.provenance.buildSha = "c".repeat(40);
    expect((await post(changed)).status).toBe(409);
    expect((await service.detail(changed.runId)).provenance.buildSha).toBe("a".repeat(40));
  });
  test("ingests dotted login chapter IDs and preserves them in admin results", async () => {
    const run = fixture();
    run.chapters = ["AUTH-08.1", "AUTH-08.2", "AUTH-08.3"].map((id, index) => ({
      ...run.chapters[0], id, videoStart: index * 2, videoEnd: index * 2 + 1,
    }));
    expect((await post(run)).status).toBe(201);
    expect((await post(run)).status).toBe(200);
    expect((await put()).status).toBe(201);
    const response = await admin.request(`/${run.runId}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as Awaited<ReturnType<TestRunService["detail"]>>;
    expect(detail.chapters).toEqual(run.chapters);
    expect(detail.outcome).toBe("passed");
    const changed = structuredClone(run);
    changed.chapters[0].id = "AUTH-08.4";
    expect((await post(changed)).status).toBe(409);
  });
  test("bounds chapter labels without allowing dotted run or asset resource IDs", async () => {
    const run = fixture();
    run.chapters[0].id = "A" + ".".repeat(119);
    expect(testRunSchema.safeParse(run).success).toBe(true);
    for (const id of ["A".repeat(121), ".AUTH-08", "AUTH/08.1", "AUTH\\08.1", "AUTH%2F08.1", "AUTH 08.1", ""]) {
      expect((await post({ ...run, chapters: [{ ...run.chapters[0], id }] })).status).toBe(400);
    }
    const variants = [
      { ...run, runId: "run.1" },
      { ...run, requestId: "request.1" },
      { ...run, routineId: "routine.1" },
      { ...run, assets: [{ ...run.assets[0], assetId: "video.1" }],
        chapters: [{ ...run.chapters[0], videoAssetId: "video.1" }] },
      { ...run, assets: [...run.assets, { ...run.assets[0], assetId: "screenshot.1", kind: "screenshot", contentType: "image/png" }],
        chapters: [{ ...run.chapters[0], screenshotAssetId: "screenshot.1" }] },
      { ...run, chapters: [run.chapters[0], run.chapters[0]] },
    ];
    for (const value of variants) expect((await post(value)).status).toBe(400);
    expect(repository.runs.size).toBe(0);
  });
  test("preserves optional firmware phases and failed test checks after a successful return", async () => {
    const run = fixture();
    expect(testRunSchema.parse(run).firmwareAssertions[0].phase).toBeUndefined();
    run.outcome = "failed";
    run.outcomes.test = "failed";
    run.firmwareAssertions = [
      { component: "BES version", expected: "26.9.21.3", actual: "17.26.1.13", status: "failed", phase: "final-assertions" },
      { component: "BES version", expected: "26.9.21.3", actual: "26.9.21.3", status: "passed", phase: "return-verification" },
    ];
    expect((await post(run)).status).toBe(201);
    const response = await admin.request(`/${run.runId}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as Awaited<ReturnType<TestRunService["detail"]>>;
    expect(detail.firmwareAssertions).toEqual(run.firmwareAssertions);
    expect(detail.outcomes).toMatchObject({ test: "failed", teardown: "passed", fixture: "ready" });
    const changed = structuredClone(run);
    changed.firmwareAssertions[0].phase = "teardown";
    expect((await post(changed)).status).toBe(409);
    expect(testRunSchema.safeParse({ ...run, firmwareAssertions: [{ ...run.firmwareAssertions[0], phase: "unknown" }] }).success).toBe(false);
  });
  test("rejects path IDs, active content, undeclared chapter targets and contradictory pass", async () => {
    const variants = [
      { ...fixture(), runId: "../escape" },
      { ...fixture(), assets: [{ ...fixture().assets[0], contentType: "image/svg+xml" }] },
      { ...fixture(), chapters: [{ ...fixture().chapters[0], videoAssetId: "missing" }] },
      { ...fixture(), outcomes: { ...fixture().outcomes, fixture: "unavailable" } },
      { ...fixture(), outcomes: { ...fixture().outcomes, evidence: "incomplete" } },
      { ...fixture(), firmwareAssertions: [{ ...fixture().firmwareAssertions[0], status: "failed" }] },
      { ...fixture(), chapters: [{ ...fixture().chapters[0], status: "not-run" }] },
    ];
    for (const value of variants) expect((await post(value)).status).toBe(400);
    expect(repository.runs.size).toBe(0);
  });
  test("limits metadata and does not accept undeclared upload IDs", async () => {
    expect((await ingest.request("/", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    await post();
    expect((await put(video, "missing")).status).toBe(404);
  });
});

describe("verified media uploads and seeking", () => {
  test("uploads JSON evidence through S3 and verifies its original size without a GET fallback", async () => {
    const bytes = Buffer.from(JSON.stringify({ instruction: "Check the firmware — 確認", details: "x".repeat(120_000) }));
    const objects = new Map<string, Buffer>();
    let gets = 0;
    const headEncodings: (string | null)[] = [];
    const s3 = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        objects.set(key, Buffer.from(await request.arrayBuffer()));
        return new Response(null, { headers: { etag: '"test"' } });
      }
      const stored = objects.get(key);
      if (!stored) return new Response(null, { status: 404 });
      if (request.method === "HEAD") {
        const encoding = request.headers.get("accept-encoding");
        headEncodings.push(encoding);
        return new Response(null, { headers: { "content-type": "application/json",
          "last-modified": "Mon, 21 Sep 2026 00:00:00 GMT", etag: '"test"',
          ...(encoding === "identity" ? { "content-length": String(stored.length) } : { "content-encoding": "gzip" }),
        } });
      }
      if (request.method === "GET") { gets++; return new Response(stored); }
      return new Response(null, { status: 405 });
    } });
    const provider = new S3StorageProvider({ endpoint: s3.url.toString(), bucket: "private-test-bucket",
      accessKeyId: "test-access-key", secretAccessKey: "test-secret-key", region: "us-east-1" });
    service = new TestRunService(repository, () => new StorageService(provider));
    ingest = createTestRunIngestApi(service);
    admin = createTestRunAdminApi(service);
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => ingest.fetch(request) });
    try {
      const run = fixture();
      run.chapters = [];
      run.assets = [{ assetId: "metadata-1", kind: "metadata", filename: "source-run.json",
        contentType: "application/json", sizeBytes: bytes.length, sha256: sha256(bytes) }];
      expect((await post(run)).status).toBe(201);
      const uploaded = await fetch(new URL("/run-example-1/assets/metadata-1", api.url), {
        method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: bytes,
      });
      expect(uploaded.status).toBe(201);
      await uploaded.arrayBuffer();
      expect(objects.size).toBe(1);
      expect([...objects.values()][0]).toEqual(bytes);
      expect(gets).toBe(0);
      expect(headEncodings).toEqual(["identity"]);
      expect((await service.detail(run.runId)).outcomes.evidence).toBe("complete");
      const downloaded = await admin.request("/run-example-1/assets/metadata-1");
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-length")).toBe(String(bytes.length));
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
      expect(headEncodings).toEqual(["identity", "identity"]);
    } finally { await api.stop(true); await s3.stop(true); }
  });
  test("accepts a recording upload over a real HTTP socket", async () => {
    const bytes = Buffer.concat([video, Buffer.alloc(9 * 1024 * 1024, 0x6d)]);
    const run = fixture();
    run.assets[0].sizeBytes = bytes.length;
    run.assets[0].sha256 = sha256(bytes);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => ingest.fetch(request) });
    try {
      const registered = await fetch(server.url, {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(run),
      });
      expect(registered.status).toBe(201);
      await registered.arrayBuffer();
      for (const status of [201, 200]) {
        const response = await fetch(new URL("/run-example-1/assets/video-1", server.url), {
          method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "video/mp4" }, body: bytes,
        });
        expect(response.status).toBe(status);
        await response.arrayBuffer();
      }
      expect((await service.detail(run.runId)).outcomes.evidence).toBe("complete");
      expect(Buffer.from(await (await admin.request("/run-example-1/assets/video-1")).arrayBuffer())).toEqual(bytes);
    } finally { await server.stop(true); }
  });
  test("keeps evidence incomplete until verified upload; repeat upload is idempotent", async () => {
    await post();
    expect((await service.detail("run-example-1")).outcomes).toEqual({ test: "passed", teardown: "passed", fixture: "ready", evidence: "incomplete" });
    expect((await service.detail("run-example-1")).outcome).toBe("blocked");
    expect((await service.list(testRunQuerySchema.parse({ outcome: "passed" }))).runs).toHaveLength(0);
    expect((await put()).status).toBe(201);
    expect((await put()).status).toBe(200);
    const detail = await service.detail("run-example-1");
    expect(detail.outcomes.evidence).toBe("complete");
    expect(detail.outcome).toBe("passed");
    expect((await service.list(testRunQuerySchema.parse({ outcome: "passed" }))).runs).toHaveLength(1);
    expect(detail.assets[0].uploaded).toBe(true);
    expect(repository.objects.size).toBe(1);
  });
  test("rejects same-size bad hashes, oversized streams, and mislabeled media", async () => {
    await post();
    expect((await put(Buffer.alloc(video.length))).status).toBe(400);
    expect((await put(Buffer.alloc(video.length + 1))).status).toBe(413);
    expect(repository.objects.size).toBe(0);
    const second = fixture(); second.runId = "bad-media"; second.assets[0].sha256 = sha256(Buffer.alloc(video.length));
    await post(second);
    const response = await ingest.request("/bad-media/assets/video-1", { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "video/mp4" }, body: Buffer.alloc(video.length) });
    expect(response.status).toBe(400);
  });
  test("streams full, ranged, suffix and HEAD without whole-object buffering", async () => {
    await post(); await put();
    const path = "/run-example-1/assets/video-1";
    const full = await admin.request(path);
    expect(full.status).toBe(200);
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(video);
    const partial = await admin.request(path, { headers: { range: "bytes=4-7" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 4-7/${video.length}`);
    expect(await partial.text()).toBe("ftyp");
    const suffix = await admin.request(path, { headers: { range: "bytes=-3" } });
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(video.subarray(-3));
    const head = await admin.request(path, { method: "HEAD", headers: { range: "bytes=4-7" } });
    expect(head.status).toBe(206); expect(head.headers.get("content-length")).toBe("4"); expect(await head.text()).toBe("");
    const invalid = await admin.request(path, { headers: { range: "bytes=1000-" } });
    expect(invalid.status).toBe(416); expect(invalid.headers.get("content-range")).toBe(`bytes */${video.length}`);
    const ifRange = await admin.request(path, { headers: { range: "bytes=4-7", "if-range": '"old"' } });
    expect(ifRange.status).toBe(200); expect((await ifRange.arrayBuffer()).byteLength).toBe(video.length);
  });
  test("preserves exact Content-Length and range bytes over a real HTTP socket", async () => {
    const bytes = Buffer.concat([video, Buffer.alloc(1024 * 1024, 0x6d)]);
    const run = fixture();
    run.assets[0].sizeBytes = bytes.length;
    run.assets[0].sha256 = sha256(bytes);
    expect((await post(run)).status).toBe(201);
    expect((await put(bytes)).status).toBe(201);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => admin.fetch(request) });
    try {
      const url = new URL("/run-example-1/assets/video-1", server.url);
      // Safari starts with bytes=0-1 and then seeks to the MP4 metadata at its tail.
      for (const [range, start, end] of [
        ["bytes=0-1", 0, 1],
        ["bytes=-8192", bytes.length - 8192, bytes.length - 1],
        ["bytes=123-65536", 123, 65536],
      ] as const) {
        const response = await fetch(url, { headers: { range } });
        expect(response.status).toBe(206);
        expect(response.headers.get("content-length")).toBe(String(end - start + 1));
        expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
        expect(response.headers.get("transfer-encoding")).toBeNull();
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
      }
      const full = await fetch(url);
      expect(full.status).toBe(200);
      expect(full.headers.get("content-length")).toBe(String(bytes.length));
      expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
      const head = await fetch(url, { method: "HEAD", headers: { range: "bytes=0-1" } });
      expect(head.status).toBe(206);
      expect(head.headers.get("content-length")).toBe("2");
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      const changed = await fetch(url, { headers: { range: "bytes=0-1", "if-range": '"old"' } });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("content-range")).toBeNull();
      expect(Buffer.from(await changed.arrayBuffer())).toEqual(bytes);
    } finally { await server.stop(true); }
  });
  test("concurrent uploads cannot overwrite the winning immutable object", async () => {
    await post();
    const results = await Promise.all([put(), put()]);
    expect(results.map(result => result.status).sort()).toEqual([200, 201]);
    expect(repository.objects.size).toBe(1);
    const result = await admin.request("/run-example-1/assets/video-1");
    expect(Buffer.from(await result.arrayBuffer())).toEqual(video);
  });
  test("never promotes an explicitly incomplete source evidence verdict", async () => {
    const run = fixture(); run.outcome = "blocked"; run.outcomes.evidence = "incomplete";
    await post(run); await put();
    expect((await service.detail(run.runId)).outcomes.evidence).toBe("incomplete");
  });
});

test("range parsing rejects multipart, reversed, unsafe and empty suffix ranges", () => {
  for (const value of ["bytes=1-2,3-4", "bytes=8-2", "bytes=-0", "bytes=-", "bytes=99999999999999999-"])
    expect(() => parseTestAssetRange(value, 20)).toThrow();
  expect(parseTestAssetRange("bytes=4-999", 20)).toEqual({ start: 4, end: 19 });
  expect(parseTestAssetRange("bytes=-999", 20)).toEqual({ start: 0, end: 19 });
});
test("query input is bounded and detail does not expose internal storage keys", async () => {
  await post(); await put();
  expect(testRunQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  expect(testRunQuerySchema.safeParse({ arbitrary: "field" }).success).toBe(false);
  expect((await admin.request("/?cursor=bad")).status).toBe(400);
  expect(JSON.stringify(await service.detail("run-example-1"))).not.toContain("storageKey");
  expect(testRunSchema.safeParse(fixture()).success).toBe(true);
});

test("S3 provider issues a real ranged HTTP GET and streams only the requested bytes", async () => {
  const requests: { method: string; range: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const range = request.headers.get("range");
    requests.push({ method: request.method, range });
    if (request.method === "HEAD") return new Response(null, { headers: {
      "content-length": String(video.length), "content-type": "video/mp4", etag: '"test"',
      "last-modified": "Mon, 21 Sep 2026 00:00:00 GMT",
    } });
    if (request.method === "GET" && range === "bytes=4-7") return new Response(video.subarray(4, 8), { status: 206,
      headers: { "content-length": "4", "content-range": `bytes 4-7/${video.length}`, "content-type": "video/mp4" } });
    return new Response("unexpected request", { status: 400 });
  } });
  try {
    const storage = new S3StorageProvider({ endpoint: server.url.toString(), bucket: "private-test-bucket",
      accessKeyId: "test-access-key", secretAccessKey: "test-secret-key", region: "us-east-1" });
    expect((await storage.statObject("run/video")).sizeBytes).toBe(video.length);
    const stream = await storage.streamObject("run/video", { start: 4, end: 7 });
    expect(Buffer.from(await new Response(stream).arrayBuffer()).toString()).toBe("ftyp");
    expect(requests).toEqual([{ method: "HEAD", range: null }, { method: "GET", range: "bytes=4-7" }]);
  } finally { server.stop(true); }
});

const failureFixture = (): TestRun => ({
  ...fixture(), outcome: "failed", outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "complete" },
  source: { schemaVersion: 1, trigger: "pr", repository: "Mentra-Community/MentraOS", channel: "pr",
    headSha: "a".repeat(40), branch: "fix/unpair", pullRequest: { number: 123, headRepository: "Mentra-Community/MentraOS",
      baseBranch: "dev", baseSha: "b".repeat(40) } },
  failures: [{ phase: "test", step: { id: "unpair:confirm", label: "Unpair the glasses" }, code: "app_crash",
    message: "The Mentra App closed after confirming Unpair.", expected: "Return to the unpaired Home screen.",
    stack: "SurfaceMountingManager.addViewAt: child already has a parent", assetIds: ["video-1"], incidentIds: [],
    redactionPolicy: "qualification-redaction-v1", missingEvidence: [] }],
});

describe("canonical failure occurrences and existing agent queue delivery", () => {
  const secret = "fixture-action-signing-key-" + "x".repeat(32);
  const environmentKeys = ["CLOUD_REPORT_AGENT_SIGNING_SECRET", "CLOUD_CORE_ENVIRONMENT", "CLOUD_REPORT_AGENT_URL", "CLOUD_TEST_FAILURE_DELIVERY_ENABLED"] as const;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret;
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";
    process.env.CLOUD_REPORT_AGENT_URL = "https://agent.invalid";
    delete process.env.CLOUD_TEST_FAILURE_DELIVERY_ENABLED;
  });
  afterEach(() => {
    for (const key of environmentKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  });
  const grant = (id: string, expires = Math.floor(Date.now() / 1000) + 300) =>
    ({ authorization: `Bearer ${signTestFailureReadGrant(id, "dev", expires, secret)}` });

  test("acceptance persists occurrence and pending delivery before uploads or any AI", async () => {
    const run = failureFixture();
    const first = await service.ingest(run);
    expect((await service.ingest(run)).occurrenceIds).toEqual(first.occurrenceIds);
    expect(first.occurrenceIds).toHaveLength(1);
    expect(repository.runs.size).toBe(1);
    const id = first.occurrenceIds[0]!;
    expect((await service.failureDetail(id)).delivery.state).toBe("pending");
    expect((await service.failureDetail(id)).evidence).toMatchObject({ complete: false, assets: [{ state: "upload-pending" }] });
    expect((await service.detail(run.runId)).outcomes).toMatchObject({ test: "failed", fixture: "ready" });
    expect((await service.list(testRunQuerySchema.parse({ occurrenceId: id }))).runs[0]?.runId).toBe(run.runId);
    expect((await service.list(testRunQuerySchema.parse({ occurrenceId: id }))).runs[0]).not.toHaveProperty("failures");
    const flush = spyOn(TestFailureDeliveryService.prototype, "flush");
    try { await startTestFailureDelivery()(); expect(flush).not.toHaveBeenCalled(); }
    finally { flush.mockRestore(); }
    await put();
    expect((await service.failureDetail(id)).evidence.complete).toBe(true);
    expect((await service.failureDetail(id)).originalOutcome).toBe("failed");
  });

  test("one Mongo insert accepts immutable result and delivery intent together", async () => {
    const run = failureFixture();
    const create = spyOn(TestRunModel, "create").mockResolvedValue({} as never);
    try {
      const result = await new MongoTestRunRepository().insert(run, "c".repeat(64));
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[0]).toMatchObject([{ payload: run, payloadSha256: "c".repeat(64),
        failureOccurrences: [{ occurrenceId: result.stored.failureOccurrences?.[0]?.occurrenceId, delivery: { state: "pending" } }] }]);
      expect(create.mock.calls[0]?.[1]).toEqual({ writeConcern: { w: "majority", j: true, wtimeout: 10_000 } });
    } finally { create.mockRestore(); }
  });

  test("exact replay reconciles an old accepted row and never resets an acknowledgment", async () => {
    const run = failureFixture();
    const result = await service.ingest(run);
    delete repository.runs.get(run.runId)!.failureOccurrences;
    expect((await service.ingest(run)).occurrenceIds).toEqual(result.occurrenceIds);
    const id = result.occurrenceIds[0]!;
    await service.acknowledgeFailure(id, "agent_123");
    const receipt = structuredClone((await service.failureDetail(id)).delivery);
    await service.ingest(run);
    await service.acknowledgeFailure(id, "agent_123");
    expect((await service.failureDetail(id)).delivery).toEqual(receipt);
    await expect(service.acknowledgeFailure(id, "different_agent")).rejects.toThrow();
    const changed = structuredClone(run); changed.failures![0]!.message = "different failure";
    await expect(service.ingest(changed)).rejects.toMatchObject({ status: 409 });
    expect((await service.failureDetail(id)).delivery).toEqual(receipt);
  });

  test("legacy failures expose unknown source and details, without granting raw logs", async () => {
    const run = failureFixture(); delete run.source; delete run.failures;
    run.notes = "private runtime note";
    run.provenance.unrestrictedDiagnostic = "private runtime data";
    const id = (await service.ingest(run)).occurrenceIds[0]!;
    const detail = await service.failureDetail(id);
    expect(detail.source).toBeNull();
    expect(detail.failure.phase).toBe("unknown");
    expect(detail.failure.missingEvidence.map(item => item.kind)).toEqual(["failure-details", "source"]);
    expect(detail.evidence).toEqual({ complete: false, assets: [] });
    expect(JSON.stringify(detail)).not.toContain("private runtime");
    expect((await service.pendingFailureDeliveries())[0]?.source).toBeNull();
  });

  test("all triggers preserve selected branches rather than defaulting to dev", async () => {
    const scenarios = [
      { trigger: "dev", channel: "dev", branch: "dev" }, { trigger: "staging", channel: "staging", branch: "staging" },
      { trigger: "nightly", channel: "staging", branch: "staging" }, { trigger: "admin", channel: "dev", branch: "dev" },
      { trigger: "pr", channel: "pr", branch: "fix/unpair" }, { trigger: "admin", channel: "pr", branch: "fix/historical" },
      { trigger: "local", channel: "local", branch: "operator/diagnosis" },
      { trigger: "manual", channel: "dev", branch: "dev" }, { trigger: "manual", channel: "staging", branch: "staging" },
      { trigger: "manual", channel: "pr", branch: "fix/manual-request" },
    ] as const;
    for (const [index, scenario] of scenarios.entries()) {
      const run = failureFixture(); run.runId += index; run.channel = scenario.channel;
      run.source = { ...run.source!, ...scenario };
      if (scenario.channel !== "pr") { delete run.prNumber; delete run.source.pullRequest; }
      else run.source.pullRequest!.baseBranch = "staging";
      const id = (await service.ingest(run)).occurrenceIds[0]!;
      expect((await service.failureDetail(id)).source).toEqual(run.source);
    }
    expect(repository.runs.size).toBe(scenarios.length);
  });

  test("rejects contradictory, duplicate or unbound metadata before acceptance", async () => {
    const run = failureFixture();
    const variants = [
      { ...run, source: { ...run.source, channel: "staging" } },
      { ...run, source: { ...run.source, repository: "Other/Repo" } },
      { ...run, provenance: { ...run.provenance, headSha: "f".repeat(40) } },
      { ...run, failures: [run.failures![0], run.failures![0]] },
      { ...run, failures: [{ ...run.failures![0], assetIds: ["missing"] }] },
      ...["../dev", "refs//dev", "-dev", "bad ref", "bad@{ref", "branch.lock"].map(branch => ({ ...run, source: { ...run.source, branch } })),
      // A manual request never admits a local build, a PR without its identity or another channel branch.
      { ...run, channel: "local", prNumber: undefined,
        source: { ...run.source, trigger: "manual", channel: "local", branch: "operator/diagnosis", pullRequest: undefined } },
      { ...run, source: { ...run.source, trigger: "manual", pullRequest: undefined } },
      { ...run, channel: "dev", prNumber: undefined,
        source: { ...run.source, trigger: "manual", channel: "dev", branch: "main", pullRequest: undefined } },
    ];
    for (const value of variants) expect((await post(value)).status).toBe(400);
    expect(repository.runs.size).toBe(0);
  });

  test("scoped read cannot list, write, cross occurrences or retrieve unassigned assets", async () => {
    const run = failureFixture();
    run.assets.push({ assetId: "private-log", kind: "log", contentType: "text/plain", filename: "private.log", sizeBytes: 1, sha256: "c".repeat(64) });
    const id = (await service.ingest(run)).occurrenceIds[0]!;
    await put();
    const app = new Hono(); app.route("/api/agent/test-failures", createTestFailureAgentApi(service));
    const path = `/api/agent/test-failures/${id}`;
    expect((await app.request(path, { headers: grant(id) })).status).toBe(200);
    expect((await app.request(`${path}/assets/video-1`, { headers: { ...grant(id), range: "bytes=4-7" } })).status).toBe(206);
    expect((await app.request(`${path}/assets/private-log`, { headers: grant(id) })).status).toBe(404);
    expect((await app.request(path, { method: "POST", headers: grant(id) })).status).toBe(401);
    expect((await app.request("/api/agent/test-failures", { headers: grant(id) })).status).toBe(401);
    expect((await app.request(path, { headers: grant("tfo_" + "0".repeat(64)) })).status).toBe(401);
    expect((await app.request(path, { headers: grant(id, 1) })).status).toBe(401);
    expect((await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    process.env.CLOUD_CORE_ENVIRONMENT = "staging";
    expect((await app.request(path, { headers: grant(id) })).status).toBe(401);
  });

  test("lost acknowledgment retries one queue item and restart skips acknowledged delivery", async () => {
    const id = (await service.ingest(failureFixture())).occurrenceIds[0]!;
    const queue = new Map<string, string>(); let calls = 0;
    const send = (async (url: unknown, options: RequestInit) => {
      calls++;
      expect(String(url)).toBe("https://agent.invalid/internal/routine-failures");
      const headers = new Headers(options.headers); const body = String(options.body);
      expect(headers.get("content-type")).toBe("application/vnd.mentra.routine-failure+json");
      expect(headers.get("x-mentra-action-signature")).toBe(signTestFailureDelivery(body, Number(headers.get("x-mentra-action-expires")), secret));
      const input = JSON.parse(body);
      expect(input).toMatchObject({ schemaVersion: 1, occurrenceId: id, revision: 1, environment: "dev" });
      expect(input).not.toHaveProperty("failure");
      const key = `${input.environment}/${input.occurrenceId}`;
      if (!queue.has(key)) queue.set(key, "agent_123");
      if (calls === 1) throw new Error("connection closed after durable remote insert");
      return Response.json({ schemaVersion: 1, occurrenceId: id, revision: 1, status: "accepted", agentRunId: queue.get(key) });
    }) as typeof fetch;
    expect(await new TestFailureDeliveryService(service, send).flush()).toMatchObject({ acknowledged: 0, pending: 1 });
    expect((await service.failureDetail(id)).delivery.state).toBe("pending");
    expect(await new TestFailureDeliveryService(service, send).flush()).toMatchObject({ acknowledged: 1, pending: 0 });
    expect(await new TestFailureDeliveryService(service, send).flush()).toMatchObject({ acknowledged: 0, pending: 0 });
    expect(queue.size).toBe(1); expect(calls).toBe(2);
    expect((await service.failureDetail(id)).delivery).toMatchObject({ state: "acknowledged", agentRunId: "agent_123" });
    expect((await service.detail("run-example-1")).outcome).toBe("failed");
  });

  test("invalid or oversized acknowledgment never clears pending delivery", async () => {
    const id = (await service.ingest(failureFixture())).occurrenceIds[0]!;
    for (const response of [Response.json({ schemaVersion: 1, occurrenceId: "tfo_" + "0".repeat(64), revision: 1, agentRunId: "agent_123", status: "accepted" }),
      new Response("x".repeat(5000)), new Response("unavailable", { status: 503 })]) {
      expect((await new TestFailureDeliveryService(service, (async () => response) as unknown as typeof fetch).flush()).acknowledged).toBe(0);
      expect((await service.failureDetail(id)).delivery.state).toBe("pending");
    }
  });
});

describe("reviewed provenance correction of an existing source-null occurrence", () => {
  const secret = "fixture-action-signing-key-" + "x".repeat(32);
  const environmentKeys = ["CLOUD_REPORT_AGENT_SIGNING_SECRET", "CLOUD_CORE_ENVIRONMENT", "CLOUD_REPORT_AGENT_URL"] as const;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret;
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";
    process.env.CLOUD_REPORT_AGENT_URL = "https://agent.invalid";
  });
  afterEach(() => {
    for (const key of environmentKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  });
  const HEAD = "d".repeat(40), ANCHOR = "0b8c7a4e-3d2f-4a1b-9c8d-7e6f5a4b3c2d";
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("synthetic-screenshot")]);
  const functional = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom-functional-chapter-0000")]);
  const metadata = Buffer.from(JSON.stringify({ synthetic: "reviewed launcher metadata" }));
  const rawLog = Buffer.from("synthetic unredacted forensic log");
  const bytes: Record<string, Buffer> = { "gate-video": video, "gate-screenshot": png, "functional-video": functional,
    "run-metadata": metadata, "raw-log": rawLog, "pending-video": video };
  const types: Record<string, "video/mp4" | "image/png" | "application/json" | "text/plain"> = { "gate-video": "video/mp4",
    "gate-screenshot": "image/png", "functional-video": "video/mp4", "run-metadata": "application/json", "raw-log": "text/plain", "pending-video": "video/mp4" };
  /** Synthetic shape of the motivating case: a local publisher, no source/failures, a passed functional
   * chapter and a failed update gate. No live identifiers or evidence. */
  const localRun = (): TestRun => ({
    runId: "synthetic-local-c13", requestId: "synthetic-local-request", routineId: "synthetic-routine", routineVersion: "1",
    platform: "android", channel: "local", startedAt: "2026-09-27T00:00:00Z", finishedAt: "2026-09-27T00:20:00Z", outcome: "blocked",
    outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "incomplete" },
    provenance: { repository: "Mentra-Community/MentraOS", headSha: HEAD }, fixture: { alias: "synthetic-phone" }, firmwareAssertions: [],
    chapters: [
      { id: "functional", instruction: "Observe the bounded functional flow", phase: "test", status: "passed", videoAssetId: "functional-video" },
      { id: "update-gate", instruction: "Press Back on the update-only page", phase: "test", status: "failed", videoAssetId: "gate-video",
        screenshotAssetId: "gate-screenshot" },
      { id: "reopen", instruction: "Reopen from Recents", phase: "verify", status: "failed", videoAssetId: "pending-video" },
    ],
    assets: Object.keys(bytes).map(assetId => ({ assetId, kind: types[assetId]!.startsWith("video") ? "video" as const
      : types[assetId] === "image/png" ? "screenshot" as const : types[assetId] === "application/json" ? "metadata" as const : "log" as const,
    contentType: types[assetId]!, filename: `${assetId}.bin`, sizeBytes: bytes[assetId]!.length, sha256: sha256(bytes[assetId]!) })),
  });
  const upload = (runId: string, assetId: string) => ingest.request(`/${runId}/assets/${assetId}`, {
    method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": types[assetId]! }, body: bytes[assetId]!,
  });
  const corrections = () => new TestFailureCorrectionService(repository);
  const REDACTION = { policy: "routine-diagnostics-v1", confirmation: "reviewed-redacted-for-occurrence-access" };
  const diag = (assets: Array<{ assetId: string; sha256: string; chapterId: string }>, redaction: unknown = REDACTION) => ({ assets, redaction });
  const adminApp = (identity: { developerId: string; email: string } | null = { developerId: "admin_reviewer", email: "reviewer@example.invalid" }) => {
    const app = new Hono<import("../types/hono.types").AppEnv>();
    app.use("*", async (c, next) => { if (identity) { c.set("isAdmin", true); c.set("developer", identity); } return next(); });
    app.route("/", createTestRunAdminApi(service, undefined, undefined, corrections()));
    return app;
  };
  const submit = (app: Hono<any>, runId: string, occurrenceId: string, body: unknown, contentType = "application/json") =>
    app.request(`/${runId}/failures/${occurrenceId}/provenance-correction`, { method: "POST", headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body) });
  const grant = (id: string) => ({ authorization: `Bearer ${signTestFailureReadGrant(id, "dev", Math.floor(Date.now() / 1000) + 300, secret)}` });
  /** Core's real intake of the run, uploads and the original generic delivery acknowledged to its anchor. */
  async function published(run = localRun(), upload_ = ["gate-video", "gate-screenshot", "functional-video", "run-metadata", "raw-log"]) {
    const ingested = await service.ingest(run);
    for (const assetId of upload_) expect((await upload(run.runId, assetId)).status).toBe(201);
    const id = ingested.occurrenceIds[0]!;
    await new TestFailureDeliveryService(service, (async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      expect(input.source).toBeNull();
      return Response.json({ schemaVersion: 1, occurrenceId: input.occurrenceId, revision: 1, agentRunId: ANCHOR, status: "accepted" });
    }) as typeof fetch).flush();
    return { run, id, payloadSha256: ingested.payloadSha256 };
  }
  const request = (p: { run: TestRun; id: string; payloadSha256: string }, change: Record<string, unknown> = {}) => ({
    schemaVersion: 1, confirmation: "add-reviewed-provenance", environment: "dev", runId: p.run.runId, payloadSha256: p.payloadSha256,
    occurrenceId: p.id, occurrenceRevision: 1, agentRunId: ANCHOR,
    reason: "Reviewed the launcher metadata asset: this local run built the dev branch at the recorded head.",
    source: { schemaVersion: 1, trigger: "local", repository: "Mentra-Community/MentraOS", channel: "local", headSha: HEAD, branch: "dev" },
    diagnostics: diag([{ assetId: "gate-video", sha256: sha256(video), chapterId: "update-gate" },
      { assetId: "gate-screenshot", sha256: sha256(png), chapterId: "update-gate" }]),
    review: { evidence: [{ assetId: "run-metadata", sha256: sha256(metadata) }] }, ...change,
  });

  test("an explicit reviewed correction adds only missing bindings; the original acceptance, occurrence and receipt never change", async () => {
    const p = await published();
    const original = structuredClone(repository.runs.get(p.run.runId)!);
    const before = await service.failureDetail(p.id);
    expect(before).toMatchObject({ source: null, sourceStatus: "missing", delivery: { state: "acknowledged", agentRunId: ANCHOR } });
    expect(before).not.toHaveProperty("provenanceCorrection");
    const app = adminApp();
    // The read names exactly what a reviewer must echo; it writes nothing.
    expect(await (await app.request(`/${p.run.runId}/failures/${p.id}/provenance-correction`)).json()).toMatchObject({
      payloadSha256: p.payloadSha256, occurrenceRevision: 1, delivery: { state: "acknowledged", agentRunId: ANCHOR }, publishedSource: null, correction: null });
    expect(repository.runs.get(p.run.runId)).toEqual(original);
    const created = await submit(app, p.run.runId, p.id, request(p));
    expect(created.status).toBe(201);
    const record = await created.json() as TestFailureProvenanceCorrection;
    expect(record).toMatchObject({ correctionId: `tpc_${record.correctionSha256}`, runId: p.run.runId, payloadSha256: p.payloadSha256,
      occurrenceId: p.id, agentRunId: ANCHOR, reviewedBy: "admin_reviewer", delivery: { state: "pending" },
      original: { source: null, assetIds: [], incidentIds: [] },
      review: { corroborated: ["repository", "channel", "headSha", "trigger"], asserted: ["branch"] } });
    // Immutable original: payload bytes/hash, occurrence identity, generic failure and acknowledgement are byte-identical.
    const after = repository.runs.get(p.run.runId)!;
    expect(after.run).toEqual(original.run); expect(after.payloadSha256).toBe(original.payloadSha256);
    expect(after.failureOccurrences).toEqual(original.failureOccurrences);
    expect((await service.ingest(p.run))).toMatchObject({ created: false, payloadSha256: p.payloadSha256, occurrenceIds: [p.id] });
    const detail = await service.detail(p.run.runId);
    expect(detail).not.toHaveProperty("source");
    expect(detail.failureOccurrences).toEqual(original.failureOccurrences!);
    expect(detail.provenanceCorrections).toEqual([record]);
    // The occurrence-scoped packet presents the reviewed effective evidence beside the original facts.
    const packet = await service.failureDetail(p.id);
    expect(packet).toMatchObject({ occurrenceId: p.id, payloadSha256: p.payloadSha256, originalOutcome: "blocked",
      source: request(p).source, sourceStatus: "corrected", delivery: before.delivery,
      // The original generic claim (its placeholder policy, no incidents) is kept; the added assets carry their own attestation.
      failure: { phase: "unknown", code: "run_blocked", assetIds: ["gate-video", "gate-screenshot"], incidentIds: [],
        redactionPolicy: "core-generated-summary-v1" },
      provenanceCorrection: { correctionId: record.correctionId, correctionSha256: record.correctionSha256, original: record.original,
        added: { redaction: REDACTION }, delivery: { state: "pending" } } });
    expect(packet.provenanceCorrection?.added).toEqual(record.added);
    expect(packet.failure.missingEvidence.map(item => item.kind)).toEqual(["failure-details", "source"]);
    expect(packet.evidence.complete).toBe(false); // A correction is not a pass or a full qualification.
    expect(JSON.stringify(packet)).not.toContain("admin_reviewer");
    const agent = new Hono(); agent.route("/api/agent/test-failures", createTestFailureAgentApi(service));
    const path = `/api/agent/test-failures/${p.id}`;
    expect((await agent.request(`${path}/assets/gate-video`, { headers: grant(p.id) })).status).toBe(200);
    for (const unassigned of ["functional-video", "run-metadata", "raw-log"])
      expect((await agent.request(`${path}/assets/${unassigned}`, { headers: grant(p.id) })).status).toBe(404);
    // An identical retry (lost reply) returns the same record; a different correction is refused and changes nothing.
    const again = await submit(app, p.run.runId, p.id, request(p));
    expect(again.status).toBe(200); expect(await again.json()).toEqual(record);
    const conflicting = await submit(app, p.run.runId, p.id, request(p, { reason: "A different reviewer conclusion about the same occurrence." }));
    expect(conflicting.status).toBe(409);
    expect(repository.runs.get(p.run.runId)!.provenanceCorrections).toEqual([record]);
    expect(await (await adminApp().request(`/${p.run.runId}/failures/${p.id}/provenance-correction`)).json()).toEqual({ schemaVersion: 1,
      runId: p.run.runId, payloadSha256: p.payloadSha256, occurrenceId: p.id, occurrenceRevision: 1, delivery: before.delivery, publishedSource: null,
      correction: record });
  });

  test("delivery uses the existing signed transport with its own purpose, is idempotent across a lost reply, and a refusal is terminal", async () => {
    const p = await published();
    const record = await (await submit(adminApp(), p.run.runId, p.id, request(p))).json() as TestFailureProvenanceCorrection;
    const receiver = new Map<string, string>(); const seen: string[] = []; let calls = 0;
    const send = (async (url: unknown, options: RequestInit) => {
      calls++;
      const headers = new Headers(options.headers), body = String(options.body), expires = Number(headers.get("x-mentra-action-expires"));
      expect(String(url)).toBe("https://agent.invalid/internal/routine-failure-corrections");
      expect(headers.get("content-type")).toBe("application/vnd.mentra.routine-failure-correction+json");
      expect(headers.get("x-mentra-action-signature")).toBe(signTestFailureCorrectionDelivery(body, expires, secret));
      // Domain separation: the occurrence-intake signature over the same bytes is different.
      expect(headers.get("x-mentra-action-signature")).not.toBe(signTestFailureDelivery(body, expires, secret));
      seen.push(body);
      expect(JSON.parse(body)).toEqual({ schemaVersion: 1, environment: "dev", occurrenceId: p.id, revision: 1, testRunId: p.run.runId,
        payloadSha256: p.payloadSha256, agentRunId: ANCHOR, correctionId: record.correctionId, correctionSha256: record.correctionSha256,
        source: request(p).source });
      receiver.set(record.correctionId, ANCHOR);
      if (calls === 1) throw new Error("connection closed after the controller retained the correction");
      return Response.json({ schemaVersion: 1, occurrenceId: p.id, revision: 1, correctionId: record.correctionId, agentRunId: ANCHOR, status: "accepted" });
    }) as typeof fetch;
    expect(await new TestFailureDeliveryService(service, send).flush()).toMatchObject({ acknowledged: 0, pending: 0, corrections: { acknowledged: 0, pending: 1 } });
    expect((await service.failureDetail(p.id)).provenanceCorrection?.delivery.state).toBe("pending");
    expect(await new TestFailureDeliveryService(service, send).flush()).toMatchObject({ corrections: { acknowledged: 1, pending: 0 } });
    expect(await new TestFailureDeliveryService(service, send).flush()).toEqual({ acknowledged: 0, pending: 0, configured: true });
    expect(calls).toBe(2); expect(new Set(seen).size).toBe(1); expect(receiver.size).toBe(1);
    const stored = repository.runs.get(p.run.runId)!;
    expect(stored.provenanceCorrections?.[0]?.delivery).toMatchObject({ state: "acknowledged", agentRunId: ANCHOR });
    expect(stored.failureOccurrences?.[0]?.delivery).toMatchObject({ state: "acknowledged", agentRunId: ANCHOR });
    // Only the original anchor can acknowledge; a mismatched or malformed ack leaves a second correction pending.
    const q = await published({ ...localRun(), runId: "synthetic-local-c13-b" });
    const second = await (await submit(adminApp(), q.run.runId, q.id, request(q))).json() as TestFailureProvenanceCorrection;
    for (const reply of [Response.json({ schemaVersion: 1, occurrenceId: q.id, revision: 1, correctionId: second.correctionId, agentRunId: "other_anchor", status: "accepted" }),
      Response.json({ schemaVersion: 1, occurrenceId: q.id, revision: 1, correctionId: record.correctionId, agentRunId: ANCHOR, status: "accepted" }),
      new Response("x".repeat(5000)), new Response("unavailable", { status: 503 })])
      await new TestFailureDeliveryService(service, (async () => reply) as unknown as typeof fetch).flush();
    expect((await service.failureDetail(q.id)).provenanceCorrection?.delivery.state).toBe("pending");
    await expect(service.acknowledgeProvenanceCorrection(second.correctionId, "other_anchor")).rejects.toMatchObject({ status: 409 });
    // An authenticated controller 409 refuses it durably: reads fall back to the original packet.
    await new TestFailureDeliveryService(service, (async () => new Response(null, { status: 409 })) as unknown as typeof fetch).flush();
    expect(repository.runs.get(q.run.runId)!.provenanceCorrections?.[0]?.delivery.state).toBe("refused");
    expect(await service.failureDetail(q.id)).toMatchObject({ source: null, sourceStatus: "missing", failure: { assetIds: [], incidentIds: [] } });
    expect(await service.pendingProvenanceCorrectionDeliveries()).toEqual([]);
  });

  test("wrong identities, environments, sources, evidence and state refuse without writing anything", async () => {
    const p = await published(localRun(), ["gate-video", "gate-screenshot", "functional-video", "run-metadata", "raw-log"]);
    const app = adminApp();
    const refused: Array<[number, Record<string, unknown>]> = [
      // A caller asserting approval never bypasses the strict schema, review or identity checks.
      [400, { approved: true }], [400, { confirmation: "approved" }], [400, { review: { evidence: [] } }], [400, { reason: "too short" }],
      [400, { environment: "staging" }], [400, { runId: "another-run" }],
      [409, { payloadSha256: "e".repeat(64) }], [409, { agentRunId: "11111111-2222-4333-8444-555555555555" }],
      // Source truth stays local: it cannot be relabeled as CI, admin or a coordinated dev run to be admitted.
      [400, { source: { schemaVersion: 1, trigger: "dev", repository: "Mentra-Community/MentraOS", channel: "dev", headSha: HEAD, branch: "dev" } }],
      [400, { source: { schemaVersion: 1, trigger: "admin", repository: "Mentra-Community/MentraOS", channel: "local", headSha: HEAD, branch: "dev" } }],
      [400, { source: { schemaVersion: 1, trigger: "local", repository: "Mentra-Community/MentraOS", channel: "local", headSha: "a".repeat(40), branch: "dev" } }],
      [400, { source: { schemaVersion: 1, trigger: "local", repository: "Other/Repo", channel: "local", headSha: HEAD, branch: "dev" } }],
      // Evidence must be declared, uploaded, hash-exact and bound to a non-passing chapter.
      [400, { review: { evidence: [{ assetId: "undeclared", sha256: sha256(metadata) }] } }],
      [400, { review: { evidence: [{ assetId: "run-metadata", sha256: "f".repeat(64) }] } }],
      [400, { review: { evidence: [{ assetId: "pending-video", sha256: sha256(video) }] } }],
      [400, { diagnostics: diag([{ assetId: "functional-video", sha256: sha256(functional), chapterId: "functional" }]) }],
      [400, { diagnostics: diag([{ assetId: "raw-log", sha256: sha256(rawLog), chapterId: "update-gate" }]) }],
      [400, { diagnostics: diag([{ assetId: "pending-video", sha256: sha256(video), chapterId: "reopen" }]) }],
      // No authenticated report-to-run association exists, so incidents cannot be added at all.
      [400, { diagnostics: { ...diag([{ assetId: "gate-video", sha256: sha256(video), chapterId: "update-gate" }]), incidentIds: ["rep_duringrun"] } }],
      // Added evidence needs its own explicit reviewed redaction attestation; a generated placeholder or missing one refuses.
      [400, { diagnostics: { assets: [{ assetId: "gate-video", sha256: sha256(video), chapterId: "update-gate" }] } }],
      [400, { diagnostics: diag([{ assetId: "gate-video", sha256: sha256(video), chapterId: "update-gate" }],
        { policy: "core-generated-summary-v1", confirmation: "reviewed-redacted-for-occurrence-access" }) }],
      [400, { diagnostics: diag([{ assetId: "gate-video", sha256: sha256(video), chapterId: "update-gate" }],
        { policy: "lifecycle-allowlist-v1", confirmation: "reviewed-redacted-for-occurrence-access" }) }],
      [400, { diagnostics: diag([{ assetId: "gate-video", sha256: sha256(video), chapterId: "update-gate" }], { policy: "routine-diagnostics-v1", confirmation: "approved" }) }],
      [400, { diagnostics: diag([]) }], [400, { diagnostics: undefined }],
    ];
    for (const [status, change] of refused) {
      const response = await submit(app, p.run.runId, p.id, request(p, change));
      expect([JSON.stringify(change), response.status]).toEqual([JSON.stringify(change), status]);
    }
    expect((await submit(app, p.run.runId, `tfo_${"0".repeat(64)}`, request(p, { occurrenceId: `tfo_${"0".repeat(64)}` }))).status).toBe(404);
    expect((await submit(app, p.run.runId, p.id, request(p), "text/plain")).status).toBe(400);
    expect((await submit(app, p.run.runId, p.id, "x".repeat(17 * 1024))).status).toBe(413);
    expect((await submit(adminApp(null), p.run.runId, p.id, request(p))).status).toBe(403);
    process.env.CLOUD_CORE_ENVIRONMENT = "staging";
    expect((await submit(app, p.run.runId, p.id, request(p))).status).toBe(400);
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";
    expect(repository.runs.get(p.run.runId)!.provenanceCorrections).toBeUndefined();
    // No acknowledged anchor yet, an insufficiently recorded head, or an already-published source also refuse.
    const pending = localRun(); pending.runId = "synthetic-local-pending"; const pendingIngest = await service.ingest(pending);
    for (const assetId of ["gate-video", "gate-screenshot", "run-metadata"]) await upload(pending.runId, assetId);
    expect((await submit(app, pending.runId, pendingIngest.occurrenceIds[0]!, request({ run: pending, id: pendingIngest.occurrenceIds[0]!,
      payloadSha256: pendingIngest.payloadSha256 }))).status).toBe(409);
    const headless = localRun(); headless.runId = "synthetic-local-headless"; delete headless.provenance.headSha;
    const h = await published(headless);
    expect((await submit(app, h.run.runId, h.id, request(h))).status).toBe(400);
    const recorded = localRun(); recorded.runId = "synthetic-local-recorded";
    recorded.source = { schemaVersion: 1, trigger: "local", repository: "Mentra-Community/MentraOS", channel: "local", headSha: HEAD, branch: "dev" };
    const r = await published(recorded);
    expect((await submit(app, r.run.runId, r.id, request(r))).status).toBe(409);
    for (const run of [pending, headless, recorded]) expect(repository.runs.get(run.runId)!.provenanceCorrections).toBeUndefined();
  });

  test("a structured source-null failure keeps its original incidents and policy; a source-only correction adds nothing else", async () => {
    const run = localRun(); run.runId = "synthetic-local-structured";
    run.failures = [{ phase: "test", step: { id: "update-gate", label: "Press Back on the update-only page" }, code: "no_transition",
      message: "Back on the update-only page made no transition.", assetIds: ["gate-screenshot"], incidentIds: ["rep_original"],
      redactionPolicy: "routine-diagnostics-v1", missingEvidence: [] }];
    const p = await published(run);
    const original = structuredClone(repository.runs.get(run.runId)!.failureOccurrences);
    const response = await submit(adminApp(), run.runId, p.id, request(p, { diagnostics: undefined }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ added: null, original: { source: null, assetIds: ["gate-screenshot"], incidentIds: ["rep_original"] } });
    expect(await service.failureDetail(p.id)).toMatchObject({ sourceStatus: "corrected", failure: { code: "no_transition",
      assetIds: ["gate-screenshot"], incidentIds: ["rep_original"], redactionPolicy: "routine-diagnostics-v1" } });
    expect(repository.runs.get(run.runId)!.failureOccurrences).toEqual(original);
  });

  test("original plus added assets must fit the unchanged 100-ID failure contract: the bound is accepted, one more refuses with no write", async () => {
    const filled = (runId: string, count: number) => {
      const run = localRun(); run.runId = runId;
      const fillers = Array.from({ length: count }, (_, index) => ({ assetId: `fill-${index}`, kind: "metadata" as const,
        contentType: "application/json" as const, filename: `fill-${index}.json`, sizeBytes: 2, sha256: sha256(Buffer.from("{}")) }));
      run.assets.push(...fillers);
      run.failures = [{ phase: "test", step: { id: "update-gate", label: "Press Back on the update-only page" }, code: "no_transition",
        message: "Back on the update-only page made no transition.", assetIds: fillers.map(item => item.assetId), incidentIds: [],
        redactionPolicy: "routine-diagnostics-v1", missingEvidence: [] }];
      return run;
    };
    const add = { diagnostics: diag([{ assetId: "gate-video", sha256: sha256(video), chapterId: "update-gate" }]) };
    const atBound = await published(filled("synthetic-local-99", 99));
    const accepted = await submit(adminApp(), atBound.run.runId, atBound.id, request(atBound, add));
    expect(accepted.status).toBe(201);
    const packet = await service.failureDetail(atBound.id);
    expect(packet.failure.assetIds).toHaveLength(100); expect(packet.failure.assetIds.at(-1)).toBe("gate-video");
    expect(packet.evidence.assets).toHaveLength(100);
    expect(testFailureSchema.shape.assetIds.safeParse(packet.failure.assetIds).success).toBe(true);
    const over = await published(filled("synthetic-local-100", 100));
    const before = structuredClone(repository.runs.get(over.run.runId)!);
    const refused = await submit(adminApp(), over.run.runId, over.id, request(over, add));
    expect(refused.status).toBe(400);
    expect(repository.runs.get(over.run.runId)).toEqual(before); // No append, truncation or change to the original 100 bindings.
    expect(await service.failureDetail(over.id)).toMatchObject({ sourceStatus: "missing", source: null });
    expect((await service.failureDetail(over.id)).failure.assetIds).toHaveLength(100);
  });

  const COMPILED = "c".repeat(40);
  const headVariant = (runId: string, provenance: Record<string, string>) => { const run = localRun(); run.runId = runId;
    run.provenance = { repository: "Mentra-Community/MentraOS", ...provenance }; return run; };
  const proposing = (p: { run: TestRun; id: string; payloadSha256: string }, headSha: string) => ({ source: { ...request(p).source, headSha } });

  test("requested head binding: a reused compilation with a different mobileSourceCommit is accepted and retained separately", async () => {
    // Ingest accepts this shape: the requested head and the (reused) mobile compilation commit legitimately differ.
    const reused = await published(headVariant("synthetic-local-reused", { headSha: HEAD, mobileSourceCommit: COMPILED }));
    const accepted = await submit(adminApp(), reused.run.runId, reused.id, request(reused));
    expect(accepted.status).toBe(201);
    expect((await accepted.json() as TestFailureProvenanceCorrection).review.corroborated).toContain("headSha");
    expect(await service.failureDetail(reused.id)).toMatchObject({ source: { headSha: HEAD },
      build: { hashes: { headSha: HEAD, mobileSourceCommit: COMPILED } } });
  });

  test("requested head binding: a head matching only the compilation commit contradicts the authoritative requested head", async () => {
    const other = await published(headVariant("synthetic-local-reused-b", { headSha: HEAD, mobileSourceCommit: COMPILED }));
    expect((await submit(adminApp(), other.run.runId, other.id, request(other, proposing(other, COMPILED)))).status).toBe(400);
    expect(repository.runs.get(other.run.runId)!.provenanceCorrections).toBeUndefined();
  });

  test("requested head binding: without a recorded requested head, a compilation commit is not an accepted fallback", async () => {
    const compiledOnly = await published(headVariant("synthetic-local-compiled-only", { mobileSourceCommit: COMPILED }));
    for (const headSha of [COMPILED, HEAD])
      expect((await submit(adminApp(), compiledOnly.run.runId, compiledOnly.id, request(compiledOnly, proposing(compiledOnly, headSha)))).status).toBe(400);
    expect(repository.runs.get(compiledOnly.run.runId)!.provenanceCorrections).toBeUndefined();
  });

  test("the correction route sits behind the existing admin gate", async () => {
    const gated = new Hono(); gated.use("*", adminAuth); gated.route("/", adminApp(null));
    const p = await published();
    for (const authorization of [`Bearer ${TOKEN}`, `Bearer ${signTestFailureReadGrant(p.id, "dev", Math.floor(Date.now() / 1000) + 300, secret)}`])
      expect((await gated.request(`/${p.run.runId}/failures/${p.id}/provenance-correction`, { method: "POST",
        headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(request(p)) })).status).toBe(401);
    expect(repository.runs.get(p.run.runId)!.provenanceCorrections).toBeUndefined();
  });
});
