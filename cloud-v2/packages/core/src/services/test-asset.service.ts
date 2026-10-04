import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, open, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TestAssetModel} from "../models/test-run.model";
import {testWriteConcern} from "../models/test-write-concern";
import {createStorageService, type StorageService} from "./storage/storage.service";
import {ByteRangeError, parseSingleByteRange} from "./storage/byte-range";
import {TestRunError} from "./test-result-error";
export interface TestAsset {assetId: string; kind: string; contentType: string; filename: string; sizeBytes: number; sha256: string}
export interface StoredTestAsset {runId: string; assetId: string; storageKey: string; sizeBytes: number; sha256: string}
export function parseTestAssetRange(header: string | null, size: number): { start: number; end: number } | undefined {
  try {
    return parseSingleByteRange(header, size);
  } catch (error) {
    if (error instanceof ByteRangeError) throw new TestRunError(416, error.message);
    throw error;
  }
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

const assets = {
  async assets(runId: string): Promise<StoredTestAsset[]> {return await TestAssetModel.find({runId}).read("primary").readConcern("majority").lean();},
  async insertAsset(asset: StoredTestAsset): Promise<StoredTestAsset> {
    try {await TestAssetModel.create([asset], {writeConcern: testWriteConcern}); return asset;}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const winner = await TestAssetModel.findOne({runId: asset.runId, assetId: asset.assetId}).read("primary").readConcern("majority").lean();
      if (!winner || winner.sizeBytes !== asset.sizeBytes || winner.sha256 !== asset.sha256) throw new TestRunError(409, "Stored asset differs from declared asset");
      return winner;
    }
  },
};
export class TestAssetService {
  constructor(private readonly repository = assets, private readonly storageFactory: () => StorageService = createStorageService) {}
  async uploadDeclaredAsset(runId: string, asset: TestAsset, body: ReadableStream<Uint8Array> | null,
    headers: Headers, acknowledge: () => Promise<void>) {
    const assetId = asset.assetId;
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
        await reader.cancel().catch(() => undefined);
        // Bun can throw when releasing a cancelled native HTTP reader. Do not
        // let that cleanup error mask the original upload failure.
        try {reader.releaseLock();} catch {}
        await file.close();
      }
      if (size !== asset.sizeBytes || hash.digest("hex") !== asset.sha256) throw new TestRunError(400, "asset size/SHA256 does not match immutable metadata");
      if (!mediaSignatureMatches(asset.contentType, prefix)) throw new TestRunError(400, "asset bytes do not match media type");
      const existing = (await this.repository.assets(runId)).find(item => item.assetId === assetId);
      if (existing) {
        if (existing.sizeBytes !== asset.sizeBytes || existing.sha256 !== asset.sha256)
          throw new TestRunError(409, "Stored asset differs from declared asset");
        await acknowledge();
        return { assetId, uploaded: true, created: false };
      }
      const storage = this.storageFactory();
      // Unique keys mean a racing/failed upload can never replace a committed object.
      const segment = (id: string) => createHash("sha256").update(id).digest("hex");
      const storageKey = `test-runs/${segment(runId)}/${segment(assetId)}/${randomUUID()}`;
      try {
        await storage.putFile({ key: storageKey, path, contentType: asset.contentType });
        if ((await storage.statObject(storageKey)).sizeBytes !== size) throw new TestRunError(409, "stored object size differs");
      } catch (error) {
        // No database publication has begun, so this private object is disposable.
        await storage.deleteObject(storageKey).catch(() => undefined);
        throw error;
      }
      const winner = await this.repository.insertAsset({ runId, assetId, storageKey, sizeBytes: size, sha256: asset.sha256 });
      if (winner.storageKey !== storageKey) await storage.deleteObject(storageKey).catch(() => undefined);
      await acknowledge();
      return { assetId, uploaded: true, created: winner.storageKey === storageKey };
      // An ambiguous DB failure deliberately leaves its unique private object for reconciliation.
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async mediaDeclaredAsset(meta: TestAsset, stored: StoredTestAsset, request: Request): Promise<Response> {
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
