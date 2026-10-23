/**
 * Phone-local SimpleStorage for bundled miniapps.
 *
 * Keys are scoped to a data partition (one account on one Core, and the
 * account's personal data or one workspace's private data; see
 * `miniappDataPartition.ts`) and the package name. Access tokens must never
 * be part of the namespace: Core access tokens rotate and are held in memory
 * only, so using one makes every app restart look like a new user.
 *
 * Values written before partitions existed were scoped by user id alone. They
 * move into that account's personal partition the first time it is read.
 */
import type {MiniappDataPartition} from "./miniappDataPartition"

export interface LocalMiniappStorageBackend {
  get(key: string): unknown | null
  has(key: string): boolean
  set(key: string, value: unknown): void
  remove(key: string): void
  keys(): string[]
}

export interface LocalMiniappStorageHooks {
  /** The partition `packageName` reads and writes now. Rejects while no account is known. */
  getPartition: (packageName: string) => Promise<MiniappDataPartition>
  backend: LocalMiniappStorageBackend
}

const KEY_ROOT = "mentraos_miniappdata/"
const LEGACY_KEY_ROOT = "mentraos_localstorage_"
const MIGRATED_ROOT = "mentraos_miniappdata_migrated/"

export class LocalMiniappStorage {
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
    const partition = await this.hooks.getPartition(packageName)
    if (!partition.id) throw new Error("Mentra user identity is unavailable")
    const prefix = `${KEY_ROOT}${partition.id}/${packageName}/`
    if (partition.personalUserId) this.migrateLegacy(partition.personalUserId, packageName, prefix)
    return prefix
  }

  private migrateLegacy(userId: string, packageName: string, prefix: string): void {
    const marker = `${MIGRATED_ROOT}${userId}/${packageName}`
    const {backend} = this.hooks
    if (backend.has(marker)) return
    const legacyPrefix = `${LEGACY_KEY_ROOT}${userId}_${packageName}_`
    for (const key of backend.keys()) {
      if (!key.startsWith(legacyPrefix)) continue
      const target = prefix + key.slice(legacyPrefix.length)
      if (!backend.has(target)) backend.set(target, backend.get(key))
      backend.remove(key)
    }
    backend.set(marker, true)
  }
}
