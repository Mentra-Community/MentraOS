/**
 * SimpleStorageManager
 *
 * Thin wrapper over `session.storage` for persistent phone-local key-value
 * storage scoped to this miniapp. Values are always strings — callers
 * JSON.stringify / JSON.parse structured data themselves.
 *
 *   const storage = new SimpleStorageManager(session)
 *   await storage.set("recentDestinations", JSON.stringify([...]))
 *   const raw = await storage.get("recentDestinations")
 */

import type {MiniappSession} from "@mentra/miniapp"
import type {PlaceDetails, SavedPlace} from "../lib/places"
import type {UnitSystem, VoiceGuidanceMode} from "../../shared/types"

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

  private static readonly SAVED_PLACES_KEY = "savedPlaces"
  private static readonly SAVED_MAX = 20

  /** Returns all saved places, most recently added first. */
  async getAllSavedPlaces(): Promise<SavedPlace[]> {
    return (await this.getJSON<SavedPlace[]>(SimpleStorageManager.SAVED_PLACES_KEY)) ?? []
  }

  /**
   * Adds or replaces a saved place (caps at 20).
   *
   * Dedup rules:
   *  - If the incoming place has `type: "home"` or `"work"`, any existing
   *    entry with the same type is replaced (a user only ever has one
   *    Home and one Work).
   *  - Otherwise dedup by `placeId` so re-saving the same untagged place
   *    moves it to the top instead of duplicating it.
   */
  async addSavedPlace(place: SavedPlace): Promise<void> {
    const current = await this.getAllSavedPlaces()
    const filtered = current.filter((p) => {
      if (place.type && p.type === place.type) return false
      if (p.placeId === place.placeId) return false
      return true
    })
    const next = [place, ...filtered].slice(0, SimpleStorageManager.SAVED_MAX)
    await this.setJSON(SimpleStorageManager.SAVED_PLACES_KEY, next)
  }

  /** Removes a saved place by placeId. No-op if it isn't saved. */
  async removeSavedPlace(placeId: string): Promise<void> {
    const current = await this.getAllSavedPlaces()
    const next = current.filter((p) => p.placeId !== placeId)
    if (next.length !== current.length) {
      await this.setJSON(SimpleStorageManager.SAVED_PLACES_KEY, next)
    }
  }

  private static readonly UNIT_SYSTEM_KEY = "unitSystem"

  /** Returns the saved distance-unit preference, defaulting to "metric". */
  async getUnitSystem(): Promise<UnitSystem> {
    const raw = await this.get(SimpleStorageManager.UNIT_SYSTEM_KEY)
    return raw === "imperial" ? "imperial" : "metric"
  }

  /** Persists the distance-unit preference. */
  async setUnitSystem(unit: UnitSystem): Promise<void> {
    await this.set(SimpleStorageManager.UNIT_SYSTEM_KEY, unit)
  }

  private static readonly VOICE_GUIDANCE_MODE_KEY = "voiceGuidanceMode"

  /** Null means the user has never chosen, so hardware-aware defaults may apply. */
  async getVoiceGuidanceMode(): Promise<VoiceGuidanceMode | null> {
    const raw = await this.get(SimpleStorageManager.VOICE_GUIDANCE_MODE_KEY)
    return raw === "off" || raw === "essential" || raw === "full" ? raw : null
  }

  async setVoiceGuidanceMode(mode: VoiceGuidanceMode): Promise<void> {
    await this.set(SimpleStorageManager.VOICE_GUIDANCE_MODE_KEY, mode)
  }
}
