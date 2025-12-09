import {storage} from "@/utils/storage/storage"

export interface GallerySettings {
  autoSaveToCameraRoll: boolean
}

export class GallerySettingsService {
  private static instance: GallerySettingsService
  private readonly SETTINGS_KEY = "gallery_settings"
  private readonly DEFAULT_SETTINGS: GallerySettings = {
    autoSaveToCameraRoll: true, // Default ON
  }

  private constructor() {}

  static getInstance(): GallerySettingsService {
    if (!GallerySettingsService.instance) {
      GallerySettingsService.instance = new GallerySettingsService()
    }
    return GallerySettingsService.instance
  }

  async getSettings(): Promise<GallerySettings> {
    const res = storage.load<GallerySettings>(this.SETTINGS_KEY)
    if (res.is_error()) {
      console.error("[GallerySettings] Error loading settings:", res.error)
      return this.DEFAULT_SETTINGS
    }
    const stored = res.value
    return {...this.DEFAULT_SETTINGS, ...stored}
  }

  async updateSettings(settings: Partial<GallerySettings>): Promise<void> {
    const current = await this.getSettings()
    const updated = {...current, ...settings}
    const res = await storage.save(this.SETTINGS_KEY, updated)
    if (res.is_error()) {
      console.error("[GallerySettings] Error saving settings:", res.error)
    }
    console.log("[GallerySettings] Settings updated:", updated)
  }

  async getAutoSaveToCameraRoll(): Promise<boolean> {
    const settings = await this.getSettings()
    return settings.autoSaveToCameraRoll
  }

  async setAutoSaveToCameraRoll(enabled: boolean): Promise<void> {
    await this.updateSettings({autoSaveToCameraRoll: enabled})
  }
}

export const gallerySettingsService = GallerySettingsService.getInstance()
