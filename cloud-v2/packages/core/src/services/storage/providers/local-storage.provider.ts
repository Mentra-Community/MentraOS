import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { PutObjectInput, StorageProvider, StoredObject } from "../storage.service";

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly opts: { rootDir: string }) {}

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const path = this.pathForKey(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    return {
      key: input.key,
      contentType: input.contentType,
      sizeBytes: input.body.byteLength,
      sha256: createHash("sha256").update(input.body).digest("hex"),
    };
  }

  async getObject(key: string): Promise<Uint8Array> {
    return readFile(this.pathForKey(key));
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.pathForKey(key), { force: true });
  }

  private pathForKey(key: string): string {
    const normalizedKey = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    if (normalizedKey.startsWith("/") || normalizedKey.includes("..")) {
      throw new Error("invalid storage key");
    }
    return join(this.opts.rootDir, normalizedKey);
  }
}
