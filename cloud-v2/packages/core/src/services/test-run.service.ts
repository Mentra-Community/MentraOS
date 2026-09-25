import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TestAssetModel, TestRunModel } from "../models/test-run.model";
import { testFailureOccurrenceIdSchema, type TestFailureOccurrence } from "../types/test-failure.types";
import { testRunIdSchema, testRunSchema, type TestAsset, type TestRun, type TestRunQuery } from "../types/test-run.types";
import { createTestFailureOccurrences } from "./test-failure-occurrence";
import { createStorageService, type StorageService } from "./storage/storage.service";

export class TestRunError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 416, message: string) { super(message); }
}
export interface StoredTestRun { run: TestRun; payloadSha256: string; failureOccurrences?: TestFailureOccurrence[] }
export interface StoredTestAsset { runId: string; assetId: string; storageKey: string; sizeBytes: number; sha256: string }
export interface TestRunRepository {
  get(runId: string): Promise<StoredTestRun | null>;
  insert(run: TestRun, payloadSha256: string): Promise<{ stored: StoredTestRun; created: boolean }>;
  list(query: TestRunQuery): Promise<StoredTestRun[]>;
  assets(runId: string): Promise<StoredTestAsset[]>;
  insertAsset(asset: StoredTestAsset): Promise<StoredTestAsset>;
  markUploadsComplete(run: TestRun): Promise<void>;
  reconcileFailures(stored: StoredTestRun): Promise<StoredTestRun>;
  failure(occurrenceId: string): Promise<StoredTestRun | null>;
  pendingFailures(limit: number): Promise<StoredTestRun[]>;
  noteFailureDeliveryAttempt(occurrenceId: string): Promise<void>;
  acknowledgeFailure(occurrenceId: string, agentRunId: string): Promise<void>;
}

function duplicate(error: unknown): boolean { return (error as { code?: number })?.code === 11000; }
const failureWriteConcern = { w: "majority" as const, j: true, wtimeout: 10_000 };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const cursorSchema = z.object({ startedAt: z.string().datetime(), runId: testRunIdSchema }).strict();
function decodeCursor(cursor: string) {
  try { return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
  catch { throw new TestRunError(400, "invalid cursor"); }
}

export class MongoTestRunRepository implements TestRunRepository {
  async get(runId: string): Promise<StoredTestRun | null> {
    const row = await TestRunModel.findOne({ runId }).read("primary").readConcern("majority").lean();
    return row ? this.stored(row) : null;
  }
  private stored(row: { payload: unknown; payloadSha256: string; failureOccurrences?: unknown[] | null }): StoredTestRun {
    return { run: row.payload as TestRun, payloadSha256: row.payloadSha256,
      failureOccurrences: (row.failureOccurrences ?? undefined) as TestFailureOccurrence[] | undefined };
  }
  async insert(run: TestRun, payloadSha256: string) {
    const failureOccurrences = createTestFailureOccurrences(run);
    try {
      await TestRunModel.create([{ runId: run.runId, requestId: run.requestId, startedAt: new Date(run.startedAt), payloadSha256, payload: run,
        failureOccurrences,
        uploadsComplete: run.assets.length === 0, outcome: run.outcome === "passed" && run.assets.length > 0 ? "blocked" : run.outcome }],
      { writeConcern: failureWriteConcern });
      return { stored: { run, payloadSha256, failureOccurrences }, created: true };
    } catch (error) {
      if (!duplicate(error)) throw error;
      const stored = await this.get(run.runId);
      if (!stored) throw error;
      return { stored, created: false };
    }
  }
  async list(query: TestRunQuery): Promise<StoredTestRun[]> {
    const filter: Record<string, unknown> = {};
    if (query.occurrenceId) filter["failureOccurrences.occurrenceId"] = query.occurrenceId;
    if (query.outcome) filter.outcome = query.outcome;
    for (const [input, path] of [["pr", "prNumber"], ["channel", "channel"],
      ["repository", "provenance.repository"], ["headSha", "provenance.headSha"], ["archiveSha256", "provenance.archiveSha256"],
      ["routineId", "routineId"], ["platform", "platform"], ["fixtureAlias", "fixture.alias"]] as const) {
      if (query[input] !== undefined) filter[`payload.${path}`] = query[input];
    }
    if (query.startedAfter || query.startedBefore) filter.startedAt = {
      ...(query.startedAfter ? { $gte: new Date(query.startedAfter) } : {}),
      ...(query.startedBefore ? { $lt: new Date(query.startedBefore) } : {}),
    };
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      filter.$or = [{ startedAt: { $lt: new Date(cursor.startedAt) } },
        { startedAt: new Date(cursor.startedAt), runId: { $lt: cursor.runId } }];
    }
    const rows = await TestRunModel.find(filter).sort({ startedAt: -1, runId: -1 }).limit(query.limit + 1).lean();
    return rows.map(row => this.stored(row));
  }
  async assets(runId: string): Promise<StoredTestAsset[]> {
    return TestAssetModel.find({ runId }).lean();
  }
  async insertAsset(asset: StoredTestAsset): Promise<StoredTestAsset> {
    try { await TestAssetModel.create(asset); return asset; }
    catch (error) {
      if (!duplicate(error)) throw error;
      const stored = await TestAssetModel.findOne({ runId: asset.runId, assetId: asset.assetId }).lean();
      if (!stored) throw error;
      return stored;
    }
  }
  async markUploadsComplete(run: TestRun): Promise<void> {
    await TestRunModel.updateOne({ runId: run.runId }, { $set: { uploadsComplete: true, outcome: run.outcome } });
  }
  async reconcileFailures(stored: StoredTestRun): Promise<StoredTestRun> {
    if (stored.failureOccurrences !== undefined) return stored;
    // Old accepted rows can be reconciled by replaying their exact metadata.
    // Never reset a delivery acknowledgment during a replay or a racing retry.
    await TestRunModel.updateOne({ runId: stored.run.runId, payloadSha256: stored.payloadSha256,
      failureOccurrences: { $exists: false } }, { $set: { failureOccurrences: createTestFailureOccurrences(stored.run) } },
    { writeConcern: failureWriteConcern });
    const reconciled = await this.get(stored.run.runId);
    if (!reconciled || reconciled.failureOccurrences === undefined) throw new Error("failure occurrence reconciliation did not persist");
    return reconciled;
  }
  async failure(occurrenceId: string): Promise<StoredTestRun | null> {
    const row = await TestRunModel.findOne({ "failureOccurrences.occurrenceId": occurrenceId }).read("primary").readConcern("majority").lean();
    return row ? this.stored(row) : null;
  }
  async pendingFailures(limit: number): Promise<StoredTestRun[]> {
    const rows = await TestRunModel.aggregate([
      { $match: { "failureOccurrences.delivery.state": "pending" } },
      { $unwind: "$failureOccurrences" },
      { $match: { "failureOccurrences.delivery.state": "pending" } },
      { $sort: { "failureOccurrences.delivery.lastAttemptAt": 1, startedAt: 1, runId: 1, "failureOccurrences.occurrenceId": 1 } },
      { $limit: limit },
      { $project: { payload: 1, payloadSha256: 1, failureOccurrences: ["$failureOccurrences"] } },
    ]).readConcern("majority");
    return rows.map(row => this.stored(row));
  }
  async noteFailureDeliveryAttempt(occurrenceId: string): Promise<void> {
    await TestRunModel.updateOne({ failureOccurrences: { $elemMatch: { occurrenceId, "delivery.state": "pending" } } }, {
      $set: { "failureOccurrences.$.delivery.lastAttemptAt": new Date().toISOString() },
    }, { writeConcern: failureWriteConcern });
  }
  async acknowledgeFailure(occurrenceId: string, agentRunId: string): Promise<void> {
    await TestRunModel.updateOne({ failureOccurrences: { $elemMatch: { occurrenceId, "delivery.state": "pending" } } }, {
      $set: { "failureOccurrences.$.delivery": { state: "acknowledged", agentRunId, acknowledgedAt: new Date().toISOString() } },
    }, { writeConcern: failureWriteConcern });
    const stored = await this.failure(occurrenceId);
    const delivery = stored?.failureOccurrences?.find(item => item.occurrenceId === occurrenceId)?.delivery;
    if (delivery?.state !== "acknowledged" || delivery.agentRunId !== agentRunId)
      throw new TestRunError(409, "occurrence already has a different delivery receipt");
  }
}

/** Single HTTP byte range, inclusive. Invalid or multipart ranges are deliberately rejected. */
export function parseTestAssetRange(header: string | null, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new TestRunError(416, "invalid byte range");
  const suffix = match[1] === "";
  const a = Number(match[1] || match[2]);
  const b = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || (suffix && a === 0)) throw new TestRunError(416, "invalid byte range");
  const start = suffix ? Math.max(0, size - a) : a;
  const end = suffix ? size - 1 : Math.min(b, size - 1);
  if (start >= size || start > end) throw new TestRunError(416, "unsatisfiable byte range");
  return { start, end };
}

function mediaSignatureMatches(type: string, bytes: Buffer): boolean {
  switch (type) {
    case "video/mp4": return bytes.subarray(4, 8).toString() === "ftyp";
    case "video/webm": return bytes.subarray(0, 4).toString("hex") === "1a45dfa3";
    case "image/png": return bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    case "image/jpeg": return bytes.subarray(0, 3).toString("hex") === "ffd8ff";
    case "image/webp": return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    default: return true; // JSON/text are served with nosniff and a sandbox CSP.
  }
}

export class TestRunService {
  constructor(private readonly repository: TestRunRepository = new MongoTestRunRepository(),
    private readonly storageFactory: () => StorageService = createStorageService) {}

  async ingest(input: unknown) {
    const parsed = testRunSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, parsed.error.issues[0]?.message ?? "invalid test run");
    const run = parsed.data;
    const payloadSha256 = createHash("sha256").update(canonical(run)).digest("hex");
    const { stored, created } = await this.repository.insert(run, payloadSha256);
    if (stored.payloadSha256 !== payloadSha256) throw new TestRunError(409, "runId already belongs to a different immutable result");
    const reconciled = await this.repository.reconcileFailures(stored);
    const uploaded = new Set((await this.repository.assets(run.runId)).map(asset => asset.assetId));
    if (run.assets.every(asset => uploaded.has(asset.assetId))) await this.repository.markUploadsComplete(run);
    return { runId: run.runId, reportPath: `/?testRun=${encodeURIComponent(run.runId)}`, created, payloadSha256,
      occurrenceIds: (reconciled.failureOccurrences ?? []).map(item => item.occurrenceId),
      missingAssetIds: run.assets.filter(asset => !uploaded.has(asset.assetId)).map(asset => asset.assetId) };
  }

  private async required(runId: string) {
    if (!testRunIdSchema.safeParse(runId).success) throw new TestRunError(400, "invalid runId");
    const stored = await this.repository.get(runId);
    if (!stored) throw new TestRunError(404, "test run not found");
    return stored.run;
  }

  async detail(runId: string) {
    await this.required(runId);
    const stored = await this.repository.get(runId);
    if (!stored) throw new TestRunError(404, "test run not found");
    return this.present(stored);
  }

  private async present(stored: StoredTestRun) {
    const { run } = stored;
    const uploaded = new Set((await this.repository.assets(run.runId)).map(asset => asset.assetId));
    const complete = run.outcomes.evidence === "complete" && run.assets.every(asset => uploaded.has(asset.assetId));
    return { ...run, ...(run.release || run.provenance.releaseIdentity ? { release: run.release ?? run.provenance.releaseIdentity } : {}),
      failureOccurrences: stored.failureOccurrences ?? [],
      outcome: run.outcome === "passed" && !complete ? "blocked" as const : run.outcome,
      outcomes: { ...run.outcomes, evidence: complete ? "complete" as const : "incomplete" as const },
      assets: run.assets.map(asset => ({ ...asset, uploaded: uploaded.has(asset.assetId) })) };
  }

  async list(query: TestRunQuery) {
    if (query.cursor) decodeCursor(query.cursor);
    const rows = await this.repository.list(query);
    const page = rows.slice(0, query.limit);
    const runs = await Promise.all(page.map(async row => {
      const { chapters, assets, firmwareAssertions, notes, failures, failureOccurrences, ...summary } = await this.present(row);
      return { ...summary, failureOccurrences: failureOccurrences.map(item => ({ occurrenceId: item.occurrenceId,
        phase: item.failure.phase, step: item.failure.step, delivery: item.delivery })) };
    }));
    const last = page.at(-1)?.run;
    return { runs, nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({
      startedAt: new Date(last.startedAt).toISOString(), runId: last.runId,
    })).toString("base64url") : null };
  }

  private async requiredFailure(occurrenceId: string) {
    if (!testFailureOccurrenceIdSchema.safeParse(occurrenceId).success) throw new TestRunError(400, "invalid occurrenceId");
    const stored = await this.repository.failure(occurrenceId);
    const occurrence = stored?.failureOccurrences?.find(item => item.occurrenceId === occurrenceId);
    if (!stored || !occurrence) throw new TestRunError(404, "failure occurrence not found");
    return { stored, occurrence };
  }

  async failureDetail(occurrenceId: string) {
    const { stored: { run, payloadSha256 }, occurrence } = await this.requiredFailure(occurrenceId);
    const uploaded = new Set((await this.repository.assets(run.runId)).map(asset => asset.assetId));
    const assets = run.assets.filter(asset => occurrence.failure.assetIds.includes(asset.assetId));
    // Do not forward free-form notes/provenance, undeclared logs, account state or
    // storage keys. Agent-visible diagnostics must be explicitly redacted inputs.
    const hashes = Object.fromEntries(Object.entries(run.provenance).filter(([key, value]) =>
      ["headSha", "baseSha", "buildSha", "mobileSourceCommit", "harnessSha", "harnessRevision", "archiveSha256", "receiptSha256", "manifestSha256", "requestSha256"].includes(key)
      && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value)));
    const workflowUrl = (value: string | undefined) => value && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(\/attempts\/\d+)?$/.test(value) ? value : null;
    const relatedRunId = (value: string | undefined) => testRunIdSchema.safeParse(value).success ? value! : null;
    return { schemaVersion: 1 as const, occurrenceId, revision: occurrence.revision,
      testRunId: run.runId, requestId: run.requestId, payloadSha256,
      routine: { id: run.routineId, version: run.routineVersion }, platform: run.platform,
      source: run.source ?? null, sourceStatus: run.source ? "recorded" as const : "missing" as const,
      build: { channel: run.channel, prNumber: run.prNumber ?? null, hashes,
        requestUrl: workflowUrl(run.provenance.requestUrl), producerUrl: workflowUrl(run.provenance.producerUrl) },
      recovery: { originalRunId: relatedRunId(run.provenance.originalRunId), previousResultRunId: relatedRunId(run.provenance.previousResultRunId) },
      originalOutcome: run.outcome, outcomes: run.outcomes,
      failure: { ...occurrence.failure, missingEvidence: [
        ...occurrence.failure.missingEvidence,
        ...(!run.source ? [{ kind: "source" as const, reason: "Authenticated branch and trigger provenance was not published; automatic editing is not admitted." }] : []),
      ] },
      evidence: { complete: Boolean(run.source) && occurrence.failure.missingEvidence.length === 0
          && run.outcomes.evidence === "complete" && assets.every(asset => uploaded.has(asset.assetId)),
        assets: assets.map(asset => ({ ...asset, state: uploaded.has(asset.assetId) ? "uploaded" as const : "upload-pending" as const,
          path: `/api/agent/test-failures/${occurrenceId}/assets/${asset.assetId}` })) },
      delivery: occurrence.delivery,
    };
  }

  async failureMedia(occurrenceId: string, assetId: string, request: Request) {
    const { stored, occurrence } = await this.requiredFailure(occurrenceId);
    if (!occurrence.failure.assetIds.includes(assetId)) throw new TestRunError(404, "asset is not assigned to this occurrence");
    return this.media(stored.run.runId, assetId, request);
  }

  async pendingFailureDeliveries(limit = 10) {
    const rows = await this.repository.pendingFailures(Math.max(1, Math.min(10, limit)));
    return rows.flatMap(({ run, failureOccurrences }) => (failureOccurrences ?? [])
      .filter(item => item.delivery.state === "pending")
      .map(item => ({ occurrenceId: item.occurrenceId, revision: item.revision, testRunId: run.runId, source: run.source ?? null }))).slice(0, limit);
  }

  async acknowledgeFailure(occurrenceId: string, agentRunId: string) {
    await this.requiredFailure(occurrenceId);
    await this.repository.acknowledgeFailure(occurrenceId, agentRunId);
  }

  async noteFailureDeliveryAttempt(occurrenceId: string) {
    await this.repository.noteFailureDeliveryAttempt(occurrenceId);
  }

  async upload(runId: string, assetId: string, body: ReadableStream<Uint8Array> | null, headers: Headers) {
    const run = await this.required(runId);
    const asset = run.assets.find(item => item.assetId === assetId);
    if (!asset) throw new TestRunError(404, "asset is not declared in this run");
    if (!body) throw new TestRunError(400, "missing asset body");
    if (headers.get("content-type") !== asset.contentType) throw new TestRunError(400, "content type does not match immutable metadata");
    if (headers.has("content-length") && headers.get("content-length") !== String(asset.sizeBytes)) throw new TestRunError(400, "content length does not match immutable metadata");
    const directory = await mkdtemp(join(tmpdir(), "mentra-test-upload-"));
    const path = join(directory, "body");
    try {
      const file = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      let prefix = Buffer.alloc(0);
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > asset.sizeBytes) throw new TestRunError(413, "asset exceeds declared size");
          hash.update(value);
          if (prefix.length < 16) prefix = Buffer.concat([prefix, value.subarray(0, 16 - prefix.length)]);
          await file.writeFile(value);
        }
        await file.sync();
      } finally {
        // This request owns the reader until it is discarded. Releasing a
        // cancelled native HTTP reader throws on reused connections in Bun.
        await reader.cancel().catch(() => undefined);
        await file.close();
      }
      if (size !== asset.sizeBytes || hash.digest("hex") !== asset.sha256) throw new TestRunError(400, "asset size/SHA256 does not match immutable metadata");
      if (!mediaSignatureMatches(asset.contentType, prefix)) throw new TestRunError(400, "asset bytes do not match media type");
      const existing = (await this.repository.assets(runId)).find(item => item.assetId === assetId);
      if (existing) {
        await this.reconcileUploads(run);
        return { assetId, uploaded: true, created: false };
      }
      const storage = this.storageFactory();
      // Unique keys mean a racing/failed upload can never replace a committed object.
      const storageKey = `test-runs/${runId}/${assetId}/${randomUUID()}`;
      await storage.putFile({ key: storageKey, path, contentType: asset.contentType });
      if ((await storage.statObject(storageKey)).sizeBytes !== size) throw new TestRunError(409, "stored object size differs");
      const winner = await this.repository.insertAsset({ runId, assetId, storageKey, sizeBytes: size, sha256: asset.sha256 });
      if (winner.storageKey !== storageKey) await storage.deleteObject(storageKey).catch(() => undefined);
      await this.reconcileUploads(run);
      return { assetId, uploaded: true, created: winner.storageKey === storageKey };
      // An ambiguous DB failure deliberately leaves its unique private object for reconciliation.
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async reconcileUploads(run: TestRun): Promise<void> {
    const uploaded = new Set((await this.repository.assets(run.runId)).map(asset => asset.assetId));
    if (run.assets.every(asset => uploaded.has(asset.assetId))) await this.repository.markUploadsComplete(run);
  }

  async media(runId: string, assetId: string, request: Request): Promise<Response> {
    const run = await this.required(runId);
    const meta = run.assets.find(asset => asset.assetId === assetId);
    const stored = (await this.repository.assets(runId)).find(asset => asset.assetId === assetId);
    if (!meta || !stored) throw new TestRunError(404, "uploaded asset not found");
    if (stored.sizeBytes !== meta.sizeBytes || stored.sha256 !== meta.sha256) throw new TestRunError(409, "stored asset metadata differs");
    const storage = this.storageFactory();
    const stat = await storage.statObject(stored.storageKey);
    if (stat.sizeBytes !== meta.sizeBytes) throw new TestRunError(409, "stored asset size changed");
    const headers = new Headers({ "Content-Type": meta.contentType, "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${meta.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store", ETag: `"${meta.sha256}"` });
    let range;
    try {
      const ifRange = request.headers.get("if-range");
      range = parseTestAssetRange(!ifRange || ifRange === headers.get("etag") ? request.headers.get("range") : null, meta.sizeBytes);
    } catch (error) {
      if (!(error instanceof TestRunError) || error.status !== 416) throw error;
      headers.set("Content-Range", `bytes */${meta.sizeBytes}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Length", String(range ? range.end - range.start + 1 : meta.sizeBytes));
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${meta.sizeBytes}`);
    let body = request.method === "HEAD" ? null : await storage.streamObject(stored.storageKey, range);
    if (!range && request.headers.has("range") && body instanceof Blob) {
      // Bun otherwise applies the original Range again to a full-file Blob,
      // overriding the 200 required when If-Range did not match. Keep it lazy.
      body = body.stream().pipeThrough(new TransformStream());
    }
    return new Response(body, { status: range ? 206 : 200, headers });
  }
}
