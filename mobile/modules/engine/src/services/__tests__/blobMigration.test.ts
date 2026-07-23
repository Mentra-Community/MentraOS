import {describe, expect, it} from "bun:test"

import {sanitizeSegment} from "../blobPaths"
import {BLOB_META_KEY_ROOT, migrateLegacyBlobScope, type MigratableBlobMeta} from "../blobMigration"
import {LEGACY_BLOB_OWNER_KEY_ROOT} from "../LocalMiniappStorage"

const PACKAGE_NAME = "com.mentra.recorder"

class MemoryMigrationBackend {
  readonly values = new Map<string, unknown>()
  readonly files = new Map<string, string>()
  failCopies = false

  storage = {
    keys: () => [...this.values.keys()],
    load: <T>(key: string) => (this.values.get(key) as T | undefined) ?? null,
    save: (key: string, value: unknown) => {
      this.values.set(key, value)
      return true
    },
    remove: (key: string) => {
      this.values.delete(key)
    },
  }

  fileKey(identity: string, fileName: string): string {
    return `${sanitizeSegment(identity)}/${PACKAGE_NAME}/${fileName}`
  }

  fileHooks = {
    exists: (identity: string, _packageName: string, fileName: string) =>
      this.files.has(this.fileKey(identity, fileName)),
    copy: (fromIdentity: string, toIdentity: string, _packageName: string, fileName: string) => {
      if (this.failCopies) throw new Error("copy failed")
      const contents = this.files.get(this.fileKey(fromIdentity, fileName))
      if (contents === undefined) throw new Error("source missing")
      this.files.set(this.fileKey(toIdentity, fileName), contents)
    },
    remove: (identity: string, _packageName: string, fileName: string) => {
      this.files.delete(this.fileKey(identity, fileName))
    },
  }
}

describe("migrateLegacyBlobScope", () => {
  it("recognizes a blob-only namespace after a same-session token refresh", () => {
    const backend = new MemoryMigrationBackend()
    const sessionId = "sess_01K123456789ABCDEFGHJKMNPQ"
    const oldToken = testCoreAccessToken("mu_123", sessionId, "jti_old", 100)
    const refreshedToken = testCoreAccessToken("mu_123", sessionId, "jti_new", 200)
    expect(sanitizeSegment(refreshedToken)).toBe(sanitizeSegment(oldToken))
    addBlob(backend, oldToken, "recording", "legacy.wav", "legacy")

    expect(
      migrateLegacyBlobScope({
        userId: "mu_123",
        packageName: PACKAGE_NAME,
        currentAccessToken: refreshedToken,
        storage: backend.storage,
        files: backend.fileHooks,
      }),
    ).toEqual({complete: true, blocked: false})
    expect(storedMeta(backend, "mu_123", "recording")?.fileName).toBe("legacy.wav")
    expect(backend.files.get(backend.fileKey("mu_123", "legacy.wav"))).toBe("legacy")
    expect(backend.values.get(`${LEGACY_BLOB_OWNER_KEY_ROOT}${sanitizeSegment(refreshedToken)}`)).toEqual({
      userId: "mu_123",
      issuedAt: 200,
    })
  })

  it("moves the newest same-user token namespace and leaves another user untouched", () => {
    const backend = new MemoryMigrationBackend()
    const oldSegment = "legacy.old.token"
    const newSegment = "legacy.new.token"
    const otherSegment = "legacy.other.token"
    addOwner(backend, oldSegment, "mu_123", 100)
    addOwner(backend, newSegment, "mu_123", 200)
    addOwner(backend, otherSegment, "mu_other", 300)
    addBlob(backend, oldSegment, "recording", "old.wav", "old")
    addBlob(backend, newSegment, "recording", "new.wav", "new")
    addBlob(backend, otherSegment, "recording", "other.wav", "other")

    expect(
      migrateLegacyBlobScope({
        userId: "mu_123",
        packageName: PACKAGE_NAME,
        storage: backend.storage,
        files: backend.fileHooks,
      }),
    ).toEqual({complete: true, blocked: false})

    expect(storedMeta(backend, "mu_123", "recording")?.fileName).toBe("new.wav")
    expect(backend.files.get(backend.fileKey("mu_123", "new.wav"))).toBe("new")
    expect(storedMeta(backend, oldSegment, "recording")).toBeNull()
    expect(storedMeta(backend, newSegment, "recording")).toBeNull()
    expect(storedMeta(backend, otherSegment, "recording")?.fileName).toBe("other.wav")
    expect(backend.files.get(backend.fileKey(otherSegment, "other.wav"))).toBe("other")
  })

  it("keeps a valid stable blob instead of overwriting it with legacy data", () => {
    const backend = new MemoryMigrationBackend()
    const legacySegment = "legacy.same.token"
    addOwner(backend, legacySegment, "mu_123", 100)
    addBlob(backend, legacySegment, "recording", "legacy.wav", "legacy")
    addBlob(backend, "mu_123", "recording", "stable.wav", "stable")

    expect(
      migrateLegacyBlobScope({
        userId: "mu_123",
        packageName: PACKAGE_NAME,
        storage: backend.storage,
        files: backend.fileHooks,
      }),
    ).toEqual({complete: true, blocked: false})

    expect(storedMeta(backend, "mu_123", "recording")?.fileName).toBe("stable.wav")
    expect(backend.files.get(backend.fileKey("mu_123", "stable.wav"))).toBe("stable")
    expect(backend.files.has(backend.fileKey(legacySegment, "legacy.wav"))).toBe(false)
  })

  it("retries an unattributed legacy token namespace instead of claiming it", () => {
    const backend = new MemoryMigrationBackend()
    const unknownSegment = "legacy.unknown.token"
    addBlob(backend, unknownSegment, "recording", "unknown.wav", "unknown")

    expect(
      migrateLegacyBlobScope({
        userId: "mu_123",
        packageName: PACKAGE_NAME,
        storage: backend.storage,
        files: backend.fileHooks,
      }),
    ).toEqual({complete: false, blocked: false})
    expect(storedMeta(backend, "mu_123", "recording")).toBeNull()
    expect(storedMeta(backend, unknownSegment, "recording")?.fileName).toBe("unknown.wav")
  })

  it("preserves the legacy metadata and file when copying fails", () => {
    const backend = new MemoryMigrationBackend()
    const legacySegment = "legacy.same.token"
    addOwner(backend, legacySegment, "mu_123", 100)
    addBlob(backend, legacySegment, "recording", "legacy.wav", "legacy")
    backend.failCopies = true

    expect(
      migrateLegacyBlobScope({
        userId: "mu_123",
        packageName: PACKAGE_NAME,
        storage: backend.storage,
        files: backend.fileHooks,
      }),
    ).toEqual({complete: false, blocked: true})
    expect(storedMeta(backend, legacySegment, "recording")?.fileName).toBe("legacy.wav")
    expect(backend.files.get(backend.fileKey(legacySegment, "legacy.wav"))).toBe("legacy")
  })
})

function addOwner(backend: MemoryMigrationBackend, segment: string, userId: string, issuedAt: number): void {
  backend.values.set(`${LEGACY_BLOB_OWNER_KEY_ROOT}${segment}`, {userId, issuedAt})
}

function addBlob(
  backend: MemoryMigrationBackend,
  identity: string,
  key: string,
  fileName: string,
  contents: string,
): void {
  backend.values.set(`${BLOB_META_KEY_ROOT}${sanitizeSegment(identity)}_${PACKAGE_NAME}_${key}`, {key, fileName})
  backend.files.set(backend.fileKey(identity, fileName), contents)
}

function storedMeta(backend: MemoryMigrationBackend, identity: string, key: string): MigratableBlobMeta | null {
  return (
    (backend.values.get(
      `${BLOB_META_KEY_ROOT}${sanitizeSegment(identity)}_${PACKAGE_NAME}_${key}`,
    ) as MigratableBlobMeta) ?? null
  )
}

function testCoreAccessToken(userId: string, sessionId: string, jti: string, issuedAt: number): string {
  // Match Core's jose claim insertion order. tenant_id + session_id occupy the
  // old 120-character filesystem prefix and session_id is deliberately reused
  // by /refresh, while jti/iat/exp rotate later in the payload.
  const header = base64UrlJson({alg: "EdDSA", kid: "mentra-access-1"})
  const payload = base64UrlJson({
    tenant_id: "mentra",
    session_id: sessionId,
    iss: "cloud-core",
    aud: "cloud-core",
    sub: userId,
    jti,
    iat: issuedAt,
    exp: issuedAt + 3600,
  })
  return `${header}.${payload}.${"s".repeat(86)}`
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}
