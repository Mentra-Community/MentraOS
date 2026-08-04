/**
 * @fileoverview Blob storage abstraction for the runtime.
 *
 * A thin wrapper over swappable blob providers (Cloudflare R2, a local-fs dev
 * provider, and the same S3 client points at Alibaba OSS / AWS / MinIO by
 * config). Services use this instead of talking to a provider directly, so the
 * camera service (and later miniapp bundles, if the runtime ever stores them)
 * is provider-agnostic.
 *
 * Mirrors the provider-wrapper pattern in Cloud Core's storage-service, but
 * instantiated within Mentra Runtime Services because the runtime is
 * self-hostable: a self-hosted runtime points at the OEM's own blob config,
 * independent of Cloud Core's instance.
 *
 * Provider is chosen by `STORAGE_PROVIDER`:
 *   - "local" (default): real temp-fs storage; the runtime serves the bytes
 *     itself (presigned URLs point at its own /api/camera/blob endpoints). For
 *     local dev, CI, and as the reference for a custom implementation, with no
 *     third-party dependency.
 *   - "r2" / "s3": Cloudflare R2 (or any S3-compatible store, including Alibaba
 *     OSS's S3 endpoint) via Bun's native S3 client. The byte path goes straight
 *     to the provider; completion arrives via the event webhook.
 *
 * See docs/issues/002-cloud-runtime/camera/spec.md and
 * docs/issues/001-cloud-core/storage-service/.
 */

import { createLocalProvider } from "./providers/local.provider";
import { createS3Provider } from "./providers/s3.provider";

/** A presigned upload target the caller hands to the device. */
export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the uploader must send (for example a fixed Content-Type). */
  headers?: Record<string, string>;
}

export interface PresignOptions {
  /** MIME type the upload will carry, fixed into the signature when relevant. */
  contentType?: string;
  /**
   * The request origin (scheme + host), used by the local provider to build
   * absolute URLs pointing back at this runtime. Ignored by remote providers,
   * whose URLs are absolute provider URLs.
   */
  origin?: string;
}

/** Bytes plus their content type, returned by the local provider's `get`. */
export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * The provider contract. `put` / `get` are implemented only by the local
 * provider (which serves its own bytes); remote providers leave them undefined
 * because their byte path does not pass through the runtime.
 */
export interface StorageProvider {
  readonly name: string;
  presignUpload(key: string, opts: PresignOptions): Promise<PresignedUpload>;
  presignDownload(key: string, opts?: PresignOptions): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** True when the runtime serves this provider's bytes (the local provider). */
  readonly servesBytes: boolean;
  put?(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get?(key: string): Promise<StoredObject | null>;
}

let provider: StorageProvider | null = null;

/** The configured storage provider (built once per process). */
export function getStorageProvider(): StorageProvider {
  if (provider) return provider;
  const kind = process.env.STORAGE_PROVIDER ?? "local";
  provider = kind === "r2" || kind === "s3" ? createS3Provider() : createLocalProvider();
  return provider;
}

/** Test/boot hook: reset the cached provider (for example to switch config). */
export function resetStorageProvider(): void {
  provider = null;
}
