import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TestAssetModel, TestRunModel } from "../models/test-run.model";
import { testRunIdSchema, testRunSchema, type TestAsset, type TestRun, type TestRunQuery } from "../types/test-run.types";
import { createStorageService, type StorageService } from "./storage/storage.service";

export class TestRunError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 416, message: string) { super(message); }
}
export interface StoredTestRun { run: TestRun; payloadSha256: string }
export interface StoredTestAsset { runId: string; assetId: string; storageKey: string; sizeBytes: number; sha256: string }
export interface TestRunRepository {
  get(runId: string): Promise<StoredTestRun | null>;
  insert(run: TestRun, payloadSha256: string): Promise<{ stored: StoredTestRun; created: boolean }>;
  list(query: TestRunQuery): Promise<StoredTestRun[]>;
  assets(runId: string): Promise<StoredTestAsset[]>;
  insertAsset(asset: StoredTestAsset): Promise<StoredTestAsset>;
  markUploadsComplete(run: TestRun): Promise<void>;
}

function duplicate(error: unknown): boolean { return (error as { code?: number })?.code === 11000; }
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
    const row = await TestRunModel.findOne({ runId }).lean();
    return row ? { run: row.payload as TestRun, payloadSha256: row.payloadSha256 } : null;
  }
  async insert(run: TestRun, payloadSha256: string) {
    try {
      await TestRunModel.create({ runId: run.runId, requestId: run.requestId, startedAt: new Date(run.startedAt), payloadSha256, payload: run,
        uploadsComplete: run.assets.length === 0, outcome: run.outcome === "passed" && run.assets.length > 0 ? "blocked" : run.outcome });
      return { stored: { run, payloadSha256 }, created: true };
    } catch (error) {
      if (!duplicate(error)) throw error;
      const stored = await this.get(run.runId);
      if (!stored) throw error;
      return { stored, created: false };
    }
  }
  async list(query: TestRunQuery): Promise<StoredTestRun[]> {
    const filter: Record<string, unknown> = {};
    if (query.outcome) filter.outcome = query.outcome;
    for (const [input, path] of [["pr", "prNumber"], ["channel", "channel"],
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
    return rows.map(row => ({ run: row.payload as TestRun, payloadSha256: row.payloadSha256 }));
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
    const uploaded = new Set((await this.repository.assets(run.runId)).map(asset => asset.assetId));
    if (run.assets.every(asset => uploaded.has(asset.assetId))) await this.repository.markUploadsComplete(run);
    return { runId: run.runId, reportPath: `/?testRun=${encodeURIComponent(run.runId)}`, created, payloadSha256,
      missingAssetIds: run.assets.filter(asset => !uploaded.has(asset.assetId)).map(asset => asset.assetId) };
  }

  private async required(runId: string) {
    if (!testRunIdSchema.safeParse(runId).success) throw new TestRunError(400, "invalid runId");
    const stored = await this.repository.get(runId);
    if (!stored) throw new TestRunError(404, "test run not found");
    return stored.run;
  }

  async detail(runId: string) {
    return this.present(await this.required(runId));
  }

  private async present(run: TestRun) {
    const uploaded = new Set((await this.repository.assets(run.runId)).map(asset => asset.assetId));
    const complete = run.outcomes.evidence === "complete" && run.assets.every(asset => uploaded.has(asset.assetId));
    return { ...run, outcome: run.outcome === "passed" && !complete ? "blocked" as const : run.outcome,
      outcomes: { ...run.outcomes, evidence: complete ? "complete" as const : "incomplete" as const },
      assets: run.assets.map(asset => ({ ...asset, uploaded: uploaded.has(asset.assetId) })) };
  }

  async list(query: TestRunQuery) {
    if (query.cursor) decodeCursor(query.cursor);
    const rows = await this.repository.list(query);
    const page = rows.slice(0, query.limit);
    const runs = await Promise.all(page.map(async row => {
      const { chapters, assets, firmwareAssertions, notes, ...summary } = await this.present(row.run);
      return summary;
    }));
    const last = page.at(-1)?.run;
    return { runs, nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({
      startedAt: new Date(last.startedAt).toISOString(), runId: last.runId,
    })).toString("base64url") : null };
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
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close(); }
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
    return new Response(request.method === "HEAD" ? null : await storage.streamObject(stored.storageKey, range),
      { status: range ? 206 : 200, headers });
  }
}
