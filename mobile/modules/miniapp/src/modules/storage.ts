/**
 * @fileoverview SimpleStorage — phone-local key-value store scoped to
 * (userId, packageName). Mirrors cloud SDK v3's StorageManager surface.
 *
 * All operations round-trip to LocalMiniappRuntime, which reads/writes
 * the phone's storage with a namespaced key format:
 *   mentraos_localstorage_{userId}_{packageName}_{key}
 *
 * Values are plain strings. Callers serialize structured data with
 * JSON.stringify themselves (matching cloud's SimpleStorage shape).
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export class SimpleStorage {
  constructor(private readonly session: MiniappSession) {}

  /** Get a value by key. Resolves to null when the key is unset. */
  async get(key: string): Promise<string | null> {
    const result = await this.session.sendRequest<{value: string | null}>({
      type: MiniappRequestType.STORAGE_GET,
      key,
    })
    return result?.value ?? null
  }

  /** Set a single key/value pair. Overwrites silently. */
  async set(key: string, value: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STORAGE_SET,
      key,
      value,
    })
  }

  /** Delete one key. No-op if the key is unset. */
  async delete(key: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STORAGE_DELETE,
      key,
    })
  }

  /** List every key in this miniapp's namespace. */
  async keys(): Promise<string[]> {
    const result = await this.session.sendRequest<{keys: string[]}>({
      type: MiniappRequestType.STORAGE_LIST,
    })
    return result?.keys ?? []
  }

  /**
   * @deprecated Renamed to `keys()` for cloud SDK parity. This alias will be
   * removed in a future release.
   */
  async list(): Promise<string[]> {
    return this.keys()
  }

  /** Drop every key in this miniapp's namespace. */
  async clear(): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STORAGE_CLEAR,
    })
  }

  /** True iff `key` is set in this miniapp's namespace. */
  async has(key: string): Promise<boolean> {
    const result = await this.session.sendRequest<{has: boolean}>({
      type: MiniappRequestType.STORAGE_HAS,
      key,
    })
    return !!result?.has
  }

  /**
   * Read every key/value pair in this miniapp's namespace. Useful for
   * hydrating state on bootstrap. Bounded by the underlying namespace
   * size — keep total stored payload small (typical < 1 MB) to avoid
   * stalling the JSContext when this resolves.
   */
  async getAll(): Promise<Record<string, string>> {
    const result = await this.session.sendRequest<{values: Record<string, string>}>({
      type: MiniappRequestType.STORAGE_GET_ALL,
    })
    return result?.values ?? {}
  }

  /** Write many key/value pairs in one round-trip. */
  async setMultiple(values: Record<string, string>): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STORAGE_SET_MULTIPLE,
      values,
    })
  }

  /**
   * Force any pending in-flight writes to disk. No-op today because the
   * host writes through immediately, but reserved so a future debounced
   * backend can honor "flush before I quit" calls without breaking the
   * API.
   */
  async flush(): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STORAGE_FLUSH,
    })
  }
}
