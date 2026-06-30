# Storage Service

**Status:** Implemented with local and R2/S3-compatible providers.

Cloud Core owns one internal storage abstraction for durable objects such as
miniapp release bundles, manifests, icons, screenshots, and promotional media.
Core services must depend on this wrapper instead of duplicating provider
specific S3/R2/local-files logic.

## Current implementation

Source:

- `packages/core/src/services/storage/storage.service.ts`
- `packages/core/src/services/storage/providers/local-storage.provider.ts`
- `packages/core/src/services/storage/providers/s3-storage.provider.ts`

The local provider keeps the Console2/CLI/Core loop working end-to-end without a
cloud bucket. The R2/S3 provider uses Bun's native S3 client so Core does not
need a separate provider SDK dependency.

```ts
interface StorageProvider {
  putObject(input: {
    key: string
    body: Uint8Array
    contentType: string
  }): Promise<StoredObject>

  getObject(key: string): Promise<Uint8Array>
  deleteObject(key: string): Promise<void>
}

interface StoredObject {
  key: string
  contentType: string
  sizeBytes: number
  sha256: string
}
```

Environment:

```txt
CLOUD_STORAGE_PROVIDER=local
CLOUD_STORAGE_LOCAL_DIR=.cloud-v2-storage/core
```

R2/S3-compatible environment:

```txt
CLOUD_STORAGE_PROVIDER=r2
CLOUD_STORAGE_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CLOUD_STORAGE_S3_BUCKET=mentra-cloud-v2-dev
CLOUD_STORAGE_S3_ACCESS_KEY_ID=...
CLOUD_STORAGE_S3_SECRET_ACCESS_KEY=...
CLOUD_STORAGE_S3_REGION=auto
```

For local/debug/dev/staging, use the shared non-production R2 credentials with
environment-specific buckets. Production must use separate credentials and a
separate bucket.

The older `CLOUD_CORE_STORAGE_*` names are accepted as aliases during the
service rename transition, but new configs should use `CLOUD_STORAGE_*`.

## Design rules

- The storage key is provider-neutral metadata owned by Core.
- Services store content type, byte size, and SHA-256 next to the business row.
- Services validate hashes after writes so corrupted or partial writes are not
  silently accepted.
- Runtime Services may use the same provider interface, but with separate
  buckets/credentials/lifecycle policies. Runtime photo storage and Core
  miniapp bundle storage are separate ownership domains.

## Next provider work

Presigned URL support should add:

- presigned upload URL creation for large release bundles and promotional media
- presigned download URL creation for mobile install/update
- object head metadata lookup
- checksum verification using provider metadata when available
