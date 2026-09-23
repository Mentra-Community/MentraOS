import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import { createTestRunIngestApi } from "../api/internal/test-runs.api";
import { adminAuth } from "../api/middleware/admin-auth.middleware";
import { TestRunModel } from "../models/test-run.model";
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
    const value = structuredClone({ run, payloadSha256 });
    this.runs.set(run.runId, value);
    this.outcomes.set(run.runId, run.outcome === "passed" && run.assets.length ? "blocked" : run.outcome);
    return { stored: value, created: true };
  }
  async list(query: TestRunQuery) { return [...this.runs.values()].filter(row => !query.outcome || this.outcomes.get(row.run.runId) === query.outcome); }
  async assets(runId: string) { return [...this.objects.values()].filter(asset => asset.runId === runId); }
  async insertAsset(asset: StoredTestAsset) {
    const key = `${asset.runId}/${asset.assetId}`;
    if (!this.objects.has(key)) this.objects.set(key, asset);
    return this.objects.get(key)!;
  }
  async markUploadsComplete(run: TestRun) { this.outcomes.set(run.runId, run.outcome); }
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
