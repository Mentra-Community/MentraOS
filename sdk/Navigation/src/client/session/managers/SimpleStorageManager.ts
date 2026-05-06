/**
 * SimpleStorageManager
 *
 * Thin wrapper over `session.storage` for persistent phone-local key-value
 * storage scoped to this miniapp. Values are always strings — callers
 * JSON.stringify / JSON.parse structured data themselves.
 *
 *   const user = useUser()
 *   await user.storage.set("recentDestinations", JSON.stringify([...]))
 *   const raw = await user.storage.get("recentDestinations")
 */

import type {MiniappSession} from "@mentra/miniapp"

export class SimpleStorageManager {
  constructor(private readonly session: MiniappSession) {}

  /** Retrieve a value by key. Returns null if the key does not exist. */
  get(key: string): Promise<string | null> {
    return this.session.storage.get(key)
  }

  /** Store a string value. Overwrites any existing value for the key. */
  set(key: string, value: string): Promise<void> {
    return this.session.storage.set(key, value)
  }

  /** Remove a key. No-op if the key does not exist. */
  delete(key: string): Promise<void> {
    return this.session.storage.delete(key)
  }

  /** List all keys currently stored for this miniapp. */
  list(): Promise<string[]> {
    return this.session.storage.list()
  }

  /** Convenience: get and JSON.parse in one call. Returns null on miss or parse error. */
  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.session.storage.get(key)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  /** Convenience: JSON.stringify and set in one call. */
  setJSON<T>(key: string, value: T): Promise<void> {
    return this.session.storage.set(key, JSON.stringify(value))
  }
}
