/**
 * Phone-local SimpleStorage for bundled miniapps.
 *
 * Keys are scoped to the stable Mentra user id and package name. Access tokens
 * must never be part of the namespace: Core access tokens rotate and are held
 * in memory only, so using one makes every app restart look like a new user.
 */

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
    const userId = (await this.hooks.getUserId()).trim()
    if (!userId) throw new Error("Mentra user identity is unavailable")
    return `${KEY_ROOT}${userId}_${packageName}_`
  }
}
