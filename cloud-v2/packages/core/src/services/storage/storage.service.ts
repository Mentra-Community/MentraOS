import { createHash } from "node:crypto";
import { LocalStorageProvider } from "./providers/local-storage.provider";

export interface PutObjectInput {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface StoredObject {
  key: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(key: string): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
}

export class StorageService {
  constructor(private readonly provider: StorageProvider) {}

  putObject(input: PutObjectInput): Promise<StoredObject> {
    return this.provider.putObject(input);
  }

  getObject(key: string): Promise<Uint8Array> {
    return this.provider.getObject(key);
  }

  deleteObject(key: string): Promise<void> {
    return this.provider.deleteObject(key);
  }
}

export function createStorageService(): StorageService {
  const provider = process.env.CLOUD_CORE_STORAGE_PROVIDER ?? "local";
  if (provider !== "local") {
    throw new Error(`unsupported CLOUD_CORE_STORAGE_PROVIDER: ${provider}`);
  }
  return new StorageService(
    new LocalStorageProvider({
      rootDir: process.env.CLOUD_CORE_LOCAL_STORAGE_DIR ?? ".cloud-v2-storage/core",
    }),
  );
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
