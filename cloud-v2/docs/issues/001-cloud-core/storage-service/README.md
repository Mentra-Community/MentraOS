# Storage Service

**Status:** Implemented as local provider first; R2/S3 providers next.

Cloud Core owns one internal storage abstraction for durable objects such as
miniapp release bundles, manifests, icons, screenshots, and promotional media.
Core services must depend on this wrapper instead of duplicating provider
specific S3/R2/local-files logic.

## Current implementation

Source:

- `packages/core/src/services/storage/storage.service.ts`
- `packages/core/src/services/storage/providers/local-storage.provider.ts`

The first provider is intentionally local so the Console2/CLI/Core loop works
end-to-end in development without a cloud bucket.

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
CLOUD_CORE_STORAGE_PROVIDER=local
CLOUD_CORE_LOCAL_STORAGE_DIR=.cloud-v2-storage/core
```

## Design rules

- The storage key is provider-neutral metadata owned by Core.
- Services store content type, byte size, and SHA-256 next to the business row.
- Services validate hashes after writes so corrupted or partial writes are not
  silently accepted.
- Runtime Services may use the same provider interface, but with separate
  buckets/credentials/lifecycle policies. Runtime photo storage and Core
  miniapp bundle storage are separate ownership domains.

## Next provider work

The R2/S3 provider should add:

- presigned upload URL creation for large release bundles and promotional media
- presigned download URL creation for mobile install/update
- object head metadata lookup
- checksum verification using provider metadata when available
