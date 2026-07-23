import {sanitizeSegment} from "./blobPaths"
import {accessTokenIdentity, LEGACY_BLOB_OWNER_KEY_ROOT, type LegacyTokenIdentity} from "./LocalMiniappStorage"

export const BLOB_META_KEY_ROOT = "mentraos_blobmeta_"

export interface MigratableBlobMeta {
  key: string
  fileName: string
}

export interface BlobMigrationStorage {
  keys(): string[]
  load<T>(key: string): T | null
  save(key: string, value: unknown): boolean
  remove(key: string): void
}

export interface BlobMigrationFiles {
  exists(identity: string, packageName: string, fileName: string): boolean
  copy(fromIdentity: string, toIdentity: string, packageName: string, fileName: string): void
  remove(identity: string, packageName: string, fileName: string): void
}

export interface BlobMigrationOptions {
  userId: string
  packageName: string
  currentAccessToken?: string
  storage: BlobMigrationStorage
  files: BlobMigrationFiles
  warn?: (message: string, error: unknown) => void
}

/**
 * Move blobs from access-token-scoped storage into the stable user namespace.
 * Returns false only when an old namespace cannot yet be attributed or a file
 * operation failed, allowing BlobStore to retry on the next request.
 */
export function migrateLegacyBlobScope(options: BlobMigrationOptions): boolean {
  const {userId, packageName, currentAccessToken, storage, files} = options
  const stableSegment = sanitizeSegment(userId)
  const stablePrefix = `${BLOB_META_KEY_ROOT}${stableSegment}_${packageName}_`
  const packageMarker = `_${packageName}_`
  const knownOwners = new Map<string, LegacyTokenIdentity>()

  const currentClaims = currentAccessToken ? accessTokenIdentity(currentAccessToken) : null
  if (currentAccessToken && currentClaims) {
    knownOwners.set(sanitizeSegment(currentAccessToken), currentClaims)
  }
  for (const key of storage.keys()) {
    if (!key.startsWith(LEGACY_BLOB_OWNER_KEY_ROOT)) continue
    const owner = storage.load<LegacyTokenIdentity>(key)
    if (owner?.userId) knownOwners.set(key.slice(LEGACY_BLOB_OWNER_KEY_ROOT.length), owner)
  }

  const legacy = new Map<
    string,
    Array<{metaKey: string; segment: string; issuedAt: number; meta: MigratableBlobMeta}>
  >()
  let unresolvedLegacyScope = false

  for (const metaKey of storage.keys()) {
    if (!metaKey.startsWith(BLOB_META_KEY_ROOT) || metaKey.startsWith(stablePrefix)) continue
    const markerIndex = metaKey.indexOf(packageMarker, BLOB_META_KEY_ROOT.length)
    if (markerIndex < BLOB_META_KEY_ROOT.length) continue

    const segment = metaKey.slice(BLOB_META_KEY_ROOT.length, markerIndex)
    // Stable user ids do not contain JWT separators. Ignore another user's
    // stable namespace; only dotted segments can be old token namespaces.
    if (!segment || segment === stableSegment || !segment.includes(".")) continue

    const owner = accessTokenIdentity(segment) ?? knownOwners.get(segment)
    if (owner && owner.userId !== userId) continue
    if (!owner) {
      // SimpleStorage may not have recorded the owner mapping yet.
      unresolvedLegacyScope = true
      continue
    }

    const meta = storage.load<MigratableBlobMeta>(metaKey)
    if (!meta?.key || !meta.fileName) continue
    const records = legacy.get(meta.key) ?? []
    records.push({metaKey, segment, issuedAt: owner.issuedAt, meta})
    legacy.set(meta.key, records)
  }

  let completed = true
  for (const [key, records] of legacy) {
    const stableMetaKey = stablePrefix + key
    let stableMeta = storage.load<MigratableBlobMeta>(stableMetaKey)
    if (stableMeta && !files.exists(userId, packageName, stableMeta.fileName)) {
      storage.remove(stableMetaKey)
      stableMeta = null
    }

    let migrationFailed = false
    if (!stableMeta) {
      const candidate = records
        .filter((record) => files.exists(record.segment, packageName, record.meta.fileName))
        .sort((a, b) => b.issuedAt - a.issuedAt)[0]
      if (candidate) {
        try {
          files.copy(candidate.segment, userId, packageName, candidate.meta.fileName)
          if (!storage.save(stableMetaKey, candidate.meta)) throw new Error("Failed to save migrated blob metadata")
          stableMeta = candidate.meta
        } catch (error) {
          completed = false
          migrationFailed = true
          options.warn?.(`failed to migrate legacy blob ${packageName}/${key}`, error)
        }
      }
    }

    if (!stableMeta) {
      if (migrationFailed) continue
      // Every source file is already gone, so only dangling metadata remains.
      for (const record of records) storage.remove(record.metaKey)
      continue
    }
    for (const record of records) {
      try {
        files.remove(record.segment, packageName, record.meta.fileName)
        storage.remove(record.metaKey)
      } catch (error) {
        completed = false
        options.warn?.(`failed to clean legacy blob ${packageName}/${key}`, error)
      }
    }
  }

  return completed && !unresolvedLegacyScope
}
