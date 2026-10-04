import {expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TestAssetService, type StoredTestAsset} from "./test-asset.service";
import {StorageService} from "./storage/storage.service";
import {LocalStorageProvider} from "./storage/providers/local-storage.provider";

const bytes = Buffer.from("declared diagnostics");
const asset = {assetId: "setup-evidence/diagnostic..part", kind: "log", contentType: "text/plain", filename: "log.txt",
  sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
const body = () => new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(bytes); controller.close();}});
test("streamed assets encode IDs, release the reader, acknowledge duplicate custody, and support byte ranges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "test-assets-"));
  const rows: StoredTestAsset[] = [];
  const storage = new StorageService(new LocalStorageProvider({rootDir: directory}));
  const service = new TestAssetService({async assets() {return rows;}, async insertAsset(row) {rows.push(row); return row;}}, () => storage);
  let acknowledgements = 0;
  const headers = new Headers({"content-type": "text/plain", "content-length": String(bytes.length)});
  try {
    const source = body();
    expect(await service.uploadDeclaredAsset("run..one", asset, source, headers, async () => {acknowledgements++;}))
      .toEqual({assetId: asset.assetId, uploaded: true, created: true});
    expect(source.locked).toBe(false);
    expect(rows[0]!.storageKey).not.toContain("..");
    expect(rows[0]!.storageKey.split("/")).toHaveLength(4);
    expect(rows[0]!.storageKey.split("/")[2]).toBe(createHash("sha256").update(asset.assetId).digest("hex"));
    expect(await service.uploadDeclaredAsset("run..one", asset, body(), headers, async () => {acknowledgements++;}))
      .toEqual({assetId: asset.assetId, uploaded: true, created: false});
    expect(acknowledgements).toBe(2);
    const range = await service.mediaDeclaredAsset(asset, rows[0]!, new Request("http://localhost/asset", {headers: {range: "bytes=2-5"}}));
    expect(range.status).toBe(206);
    expect(range.headers.get("content-length")).toBe("4");
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(2, 6));
    const invalid = body();
    await expect(service.uploadDeclaredAsset("run..one", {...asset, sizeBytes: 2}, invalid,
      new Headers({"content-type": "text/plain"}), async () => {acknowledgements++;})).rejects.toThrow("declared size");
    expect(invalid.locked).toBe(false);
    expect(acknowledgements).toBe(2);
    rows[0]!.sha256 = "0".repeat(64);
    await expect(service.uploadDeclaredAsset("run..one", asset, body(), headers, async () => {})).rejects.toThrow("Stored asset differs");
  } finally {await rm(directory, {recursive: true, force: true});}
});


test("maximum accepted run and asset identities upload through bounded unique storage keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "test-asset-boundary-"));
  const rows: StoredTestAsset[] = [], runId = "r".repeat(240), assetId = "setup-evidence/" + "a".repeat(485);
  const metadata = {...asset, assetId};
  const storage = new StorageService(new LocalStorageProvider({rootDir: directory}));
  const service = new TestAssetService({async assets() {return rows;}, async insertAsset(row) {rows.push(row); return row;}}, () => storage);
  const headers = new Headers({"content-type": metadata.contentType, "content-length": String(bytes.length)});
  let acknowledged = 0;
  try {
    expect(assetId.length).toBe(500);
    await service.uploadDeclaredAsset(runId, metadata, body(), headers, async () => {acknowledged++;});
    const segments = rows[0]!.storageKey.split("/");
    expect(segments[1]).toBe(createHash("sha256").update(runId).digest("hex"));
    expect(segments[2]).toBe(createHash("sha256").update(assetId).digest("hex"));
    expect(segments.every(segment => Buffer.byteLength(segment) <= 255)).toBe(true);
    expect(Buffer.byteLength(rows[0]!.storageKey)).toBeLessThanOrEqual(1024);
    expect(rows[0]!.assetId).toBe(assetId);
    expect(await (await service.mediaDeclaredAsset(metadata, rows[0]!, new Request("http://localhost/asset"))).text()).toBe(bytes.toString());
    expect(await service.uploadDeclaredAsset(runId, metadata, body(), headers, async () => {acknowledged++;}))
      .toEqual({assetId, uploaded: true, created: false});
    expect(rows).toHaveLength(1);
    expect(acknowledged).toBe(2);
  } finally {await rm(directory, {recursive: true, force: true});}
});
