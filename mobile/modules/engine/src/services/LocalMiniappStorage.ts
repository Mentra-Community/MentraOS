/**
 * Phone-local SimpleStorage for bundled miniapps.
 *
 * Keys are scoped to the stable Mentra user id and package name. Access tokens
 * must never be part of the namespace: Core access tokens rotate and are held
 * in memory only, so using one makes every app restart look like a new user.
 */

import {sanitizeSegment} from "./blobPaths"

export interface LocalMiniappStorageBackend {
  get(key: string): unknown | null
  has(key: string): boolean
  set(key: string, value: unknown): void
  remove(key: string): void
  keys(): string[]
}

export interface LocalMiniappStorageHooks {
  getUserId: () => Promise<string>
  backend: LocalMiniappStorageBackend
}

const KEY_ROOT = "mentraos_localstorage_"
/**
 * A short, non-authenticating legacy token prefix → stable identity mapping.
 * BlobStore used the same truncated prefix for its old on-disk namespace, so
 * retaining this mapping lets it migrate after SimpleStorage removes the full
 * legacy token keys.
 */
export const LEGACY_BLOB_OWNER_KEY_ROOT = "mentraos_legacy_blob_owner_"

export interface LegacyTokenIdentity {
  userId: string
  issuedAt: number
}

/** Persist only the old 120-character path prefix, never the access token. */
export function rememberLegacyBlobOwner(
  backend: Pick<LocalMiniappStorageBackend, "set">,
  token: string,
  expectedUserId: string,
): LegacyTokenIdentity | null {
  const claims = accessTokenIdentity(token)
  if (!claims || claims.userId !== expectedUserId) return null
  backend.set(`${LEGACY_BLOB_OWNER_KEY_ROOT}${sanitizeSegment(token)}`, claims)
  return claims
}

/** Index every full legacy SimpleStorage token before blob requests can race it. */
export function indexLegacyBlobOwners(backend: Pick<LocalMiniappStorageBackend, "keys" | "set">): void {
  for (const fullKey of backend.keys()) {
    if (!fullKey.startsWith(KEY_ROOT)) continue
    // Core JWTs are longer than BlobStore's old 120-character segment, so the
    // remainder starts with the complete header + payload even though it also
    // contains the package/key suffix. accessTokenIdentity reads only payload.
    const tokenAndSuffix = fullKey.slice(KEY_ROOT.length)
    const claims = accessTokenIdentity(tokenAndSuffix)
    if (claims) rememberLegacyBlobOwner(backend, tokenAndSuffix, claims.userId)
  }
}

export class LocalMiniappStorage {
  private readonly migratedScopes = new Set<string>()

  constructor(private readonly hooks: LocalMiniappStorageHooks) {}

  async get(packageName: string, key: string): Promise<unknown | null> {
    return this.hooks.backend.get((await this.prefix(packageName)) + key)
  }

  async set(packageName: string, key: string, value: unknown): Promise<void> {
    this.hooks.backend.set((await this.prefix(packageName)) + key, value)
  }

  async delete(packageName: string, key: string): Promise<void> {
    this.hooks.backend.remove((await this.prefix(packageName)) + key)
  }

  async keys(packageName: string): Promise<string[]> {
    const prefix = await this.prefix(packageName)
    return this.hooks.backend
      .keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  }

  async clear(packageName: string): Promise<void> {
    const prefix = await this.prefix(packageName)
    for (const key of this.hooks.backend.keys()) {
      if (key.startsWith(prefix)) this.hooks.backend.remove(key)
    }
  }

  async has(packageName: string, key: string): Promise<boolean> {
    return this.hooks.backend.has((await this.prefix(packageName)) + key)
  }

  async getAll(packageName: string): Promise<Record<string, string>> {
    const prefix = await this.prefix(packageName)
    const values: Record<string, string> = {}
    for (const key of this.hooks.backend.keys()) {
      if (!key.startsWith(prefix)) continue
      if (!this.hooks.backend.has(key)) continue
      const value = this.hooks.backend.get(key)
      values[key.slice(prefix.length)] = typeof value === "string" ? value : String(value ?? "")
    }
    return values
  }

  async setMultiple(packageName: string, values: Record<string, unknown>): Promise<void> {
    const prefix = await this.prefix(packageName)
    for (const [key, value] of Object.entries(values)) {
      this.hooks.backend.set(prefix + key, value ?? null)
    }
  }

  private async prefix(packageName: string): Promise<string> {
    const userId = (await this.hooks.getUserId()).trim()
    if (!userId) throw new Error("Mentra user identity is unavailable")
    const prefix = `${KEY_ROOT}${userId}_${packageName}_`
    this.migrateLegacyTokenScope(userId, packageName, prefix)
    return prefix
  }

  /**
   * Move values written by the old access-token-scoped implementation into the
   * stable namespace. Core tokens carry the stable user id in `sub`; when more
   * than one rotated token contains the same key, the newest `iat` wins. A
   * value already written to the stable namespace always wins over legacy data.
   */
  private migrateLegacyTokenScope(userId: string, packageName: string, stablePrefix: string): void {
    const scope = `${userId}\0${packageName}`
    if (this.migratedScopes.has(scope)) return

    const packageMarker = `_${packageName}_`
    const candidates = new Map<string, {fullKey: string; issuedAt: number}>()
    const legacyKeys: string[] = []

    for (const fullKey of this.hooks.backend.keys()) {
      if (!fullKey.startsWith(KEY_ROOT) || fullKey.startsWith(stablePrefix)) continue
      const markerIndex = fullKey.indexOf(packageMarker, KEY_ROOT.length)
      if (markerIndex < KEY_ROOT.length) continue

      const token = fullKey.slice(KEY_ROOT.length, markerIndex)
      const claims = rememberLegacyBlobOwner(this.hooks.backend, token, userId)
      if (!claims) continue

      const key = fullKey.slice(markerIndex + packageMarker.length)
      if (!key) continue
      legacyKeys.push(fullKey)
      const existing = candidates.get(key)
      if (!existing || claims.issuedAt > existing.issuedAt) {
        candidates.set(key, {fullKey, issuedAt: claims.issuedAt})
      }
    }

    for (const [key, candidate] of candidates) {
      const stableKey = stablePrefix + key
      if (!this.hooks.backend.has(stableKey) && this.hooks.backend.has(candidate.fullKey)) {
        this.hooks.backend.set(stableKey, this.hooks.backend.get(candidate.fullKey))
      }
    }
    for (const key of legacyKeys) this.hooks.backend.remove(key)
    this.migratedScopes.add(scope)
  }
}

export function accessTokenIdentity(token: string): LegacyTokenIdentity | null {
  const payload = token.split(".")[1]
  if (!payload) return null

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
    const claims = JSON.parse(atob(padded)) as {sub?: unknown; iat?: unknown}
    if (typeof claims.sub !== "string" || !claims.sub) return null
    return {userId: claims.sub, issuedAt: typeof claims.iat === "number" ? claims.iat : 0}
  } catch {
    return null
  }
}
