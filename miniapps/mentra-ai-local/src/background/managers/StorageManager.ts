/**
 * StorageManager — persists user settings via session.storage.
 *
 * Replaces the cloud app's MongoDB user-settings collection. session.storage
 * is phone-local key-value scoped to (user, package); we keep the whole
 * Settings object under one JSON key.
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import {DEFAULT_SETTINGS, type Settings, type Theme} from "../../shared/types"

const SETTINGS_KEY = "settings"

export class StorageManager {
  private cache: Settings = {...DEFAULT_SETTINGS}

  constructor(private readonly session: MiniappSession) {}

  /** Load settings from storage into cache. Call once at startup. */
  async load(): Promise<Settings> {
    try {
      const raw = await this.session.storage.get(SETTINGS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Settings>
        this.cache = {...DEFAULT_SETTINGS, ...parsed}
      }
    } catch (error) {
      console.warn("Failed to load settings, using defaults:", error)
      this.cache = {...DEFAULT_SETTINGS}
    }
    return this.cache
  }

  /** Current settings (from cache; call load() first). */
  get(): Settings {
    return {...this.cache}
  }

  /** Merge a partial update, persist, and return the merged result. */
  async set(patch: Partial<Settings>): Promise<Settings> {
    this.cache = {...this.cache, ...patch}
    await this.persist()
    return this.get()
  }

  async setTheme(theme: Theme): Promise<void> {
    await this.set({theme})
  }

  private async persist(): Promise<void> {
    try {
      await this.session.storage.set(SETTINGS_KEY, JSON.stringify(this.cache))
    } catch (error) {
      console.warn("Failed to persist settings:", error)
    }
  }
}
