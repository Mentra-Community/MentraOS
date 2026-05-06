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
import type {PlaceDetails} from "@/client/lib/places/places"

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

  private static readonly RECENT_SEARCHES_KEY = "recentSearches"
  private static readonly RECENT_SEARCHES_MAX = 10

  /** Returns the saved list of recent searches, most recent first. */
  async getRecentSearches(): Promise<PlaceDetails[]> {
    return (await this.getJSON<PlaceDetails[]>(SimpleStorageManager.RECENT_SEARCHES_KEY)) ?? []
  }

  /** Prepends a place to the recent searches list, deduplicates by placeId, and caps at 10. */
  async addRecentSearch(place: PlaceDetails): Promise<void> {
    const current = await this.getRecentSearches()
    const next = [place, ...current.filter((p) => p.placeId !== place.placeId)].slice(0, SimpleStorageManager.RECENT_SEARCHES_MAX)
    await this.setJSON(SimpleStorageManager.RECENT_SEARCHES_KEY, next)
  }

  private static readonly HOME_KEY = "savedPlace:home"
  private static readonly WORK_KEY = "savedPlace:work"

  /** Returns the saved home address, or null if not set. */
  getHome(): Promise<PlaceDetails | null> {
    return this.getJSON<PlaceDetails>(SimpleStorageManager.HOME_KEY)
  }

  /** Saves the home address. */
  setHome(place: PlaceDetails): Promise<void> {
    return this.setJSON(SimpleStorageManager.HOME_KEY, place)
  }

  /** Clears the saved home address. */
  clearHome(): Promise<void> {
    return this.delete(SimpleStorageManager.HOME_KEY)
  }

  /** Returns the saved work address, or null if not set. */
  getWork(): Promise<PlaceDetails | null> {
    return this.getJSON<PlaceDetails>(SimpleStorageManager.WORK_KEY)
  }

  /** Saves the work address. */
  setWork(place: PlaceDetails): Promise<void> {
    return this.setJSON(SimpleStorageManager.WORK_KEY, place)
  }

  /** Clears the saved work address. */
  clearWork(): Promise<void> {
    return this.delete(SimpleStorageManager.WORK_KEY)
  }
}
