import {getTimeZone} from "react-native-localize"
import {AsyncResult, result as Res, Result} from "typesafe-ts"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

import restComms from "@/services/RestComms"
import {storage} from "@/utils/storage"

interface Setting {
  key: string
  defaultValue: () => any
  writable: boolean
  saveOnServer: boolean
  // change the key to a different key based on the indexer
  // NEVER do any network calls in the indexer (or performance will suffer greatly
  indexer?: (key: string) => string
  // optionally override the value of the setting when it's accessed
  override?: () => any
  // onWrite?: () => void
  persist: boolean
}

export const SETTINGS: Record<string, Setting> = {
  // feature flags / mantle settings:
  dev_mode: {key: "dev_mode", defaultValue: () => __DEV__, writable: true, saveOnServer: true, persist: true},
  enable_squircles: {
    key: "enable_squircles",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  debug_console: {
    key: "debug_console",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  china_deployment: {
    key: "china_deployment",
    defaultValue: () => (process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china" ? true : false),
    override: () => (process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china" ? true : false),
    writable: false,
    saveOnServer: false,
    persist: true,
  },
  backend_url: {
    key: "backend_url",
    defaultValue: () => {
      if (process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE) {
        return process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE
      }
      if (process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china") {
        return "https://api.mentraglass.cn:443"
      }
      return "https://api.mentra.glass"
    },
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  store_url: {
    key: "store_url",
    defaultValue: () => {
      if (process.env.EXPO_PUBLIC_STORE_URL_OVERRIDE) {
        return process.env.EXPO_PUBLIC_STORE_URL_OVERRIDE
      }
      if (process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china") {
        return "https://store.mentraglass.cn"
      }
      return "https://apps.mentra.glass"
    },
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  reconnect_on_app_foreground: {
    key: "reconnect_on_app_foreground",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  location_tier: {key: "location_tier", defaultValue: () => "", writable: true, saveOnServer: true, persist: true},
  // state:
  core_token: {key: "core_token", defaultValue: () => "", writable: true, saveOnServer: true, persist: true},
  default_wearable: {
    key: "default_wearable",
    defaultValue: () => "",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  device_name: {key: "device_name", defaultValue: () => "", writable: true, saveOnServer: true, persist: true},
  device_address: {
    key: "device_address",
    defaultValue: () => "",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // ui state:
  theme_preference: {
    key: "theme_preference",
    defaultValue: () => "light",
    // Force light mode - dark mode is not complete yet
    override: () => "light",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  enable_phone_notifications: {
    key: "enable_phone_notifications",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  settings_access_count: {
    key: "settings_access_count",
    defaultValue: () => 0,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  show_advanced_settings: {
    key: "show_advanced_settings",
    defaultValue: () => false,
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  onboarding_completed: {
    key: "onboarding_completed",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  has_ever_activated_app: {
    key: "has_ever_activated_app",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },

  // core settings:
  sensing_enabled: {
    key: "sensing_enabled",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  power_saving_mode: {
    key: "power_saving_mode",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  always_on_status_bar: {
    key: "always_on_status_bar",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  bypass_vad_for_debugging: {
    key: "bypass_vad_for_debugging",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  bypass_audio_encoding_for_debugging: {
    key: "bypass_audio_encoding_for_debugging",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  metric_system: {
    key: "metric_system",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  enforce_local_transcription: {
    key: "enforce_local_transcription",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  preferred_mic: {
    key: "preferred_mic",
    defaultValue: () => "auto",
    writable: true,
    indexer: (key: string) => {
      const glasses = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
      if (glasses) {
        return `${key}:${glasses}`
      }
      return key
    },
    saveOnServer: true,
    persist: true,
  },
  screen_disabled: {
    key: "screen_disabled",
    defaultValue: () => false,
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  // glasses settings:
  contextual_dashboard: {
    key: "contextual_dashboard",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  head_up_angle: {key: "head_up_angle", defaultValue: () => 45, writable: true, saveOnServer: true, persist: true},
  brightness: {key: "brightness", defaultValue: () => 50, writable: true, saveOnServer: true, persist: true},
  auto_brightness: {
    key: "auto_brightness",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  dashboard_height: {
    key: "dashboard_height",
    defaultValue: () => 4,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  dashboard_depth: {
    key: "dashboard_depth",
    defaultValue: () => 5,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // button settings
  button_mode: {key: "button_mode", defaultValue: () => "photo", writable: true, saveOnServer: true, persist: true},
  button_photo_size: {
    key: "button_photo_size",
    defaultValue: () => "large",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  button_video_settings: {
    key: "button_video_settings",
    defaultValue: () => ({width: 1920, height: 1080, fps: 30}),
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  button_camera_led: {
    key: "button_camera_led",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  button_video_settings_width: {
    key: "button_video_settings_width",
    defaultValue: () => 1920,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  button_max_recording_time: {
    key: "button_max_recording_time",
    defaultValue: () => 10,
    writable: true,
    saveOnServer: true,
    persist: true,
  },

  // time zone settings
  time_zone: {
    key: "time_zone",
    defaultValue: () => "",
    writable: true,
    override: () => {
      const override = useSettingsStore.getState().getSetting(SETTINGS.time_zone_override.key)
      if (override) {
        return override
      }
      return getTimeZone()
    },
    saveOnServer: true,
    persist: true,
  },
  time_zone_override: {
    key: "time_zone_override",
    defaultValue: () => "",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // offline applets
  offline_mode: {key: "offline_mode", defaultValue: () => false, writable: true, saveOnServer: true, persist: true},
  offline_captions_running: {
    key: "offline_captions_running",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  gallery_mode: {key: "gallery_mode", defaultValue: () => false, writable: true, saveOnServer: true, persist: true},
  // button action settings
  default_button_action_enabled: {
    key: "default_button_action_enabled",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  default_button_action_app: {
    key: "default_button_action_app",
    defaultValue: () => "com.mentra.camera",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // notifications
  notifications_enabled: {
    key: "notifications_enabled",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  notifications_blocklist: {
    key: "notifications_blocklist",
    defaultValue: () => [],
    writable: true,
    saveOnServer: true,
    persist: true,
  },
} as const

export const OFFLINE_APPLETS: string[] = ["com.mentra.livecaptions", "com.mentra.camera"]

// these settings are automatically synced to the core:
const CORE_SETTINGS_KEYS: string[] = [
  SETTINGS.sensing_enabled.key,
  SETTINGS.power_saving_mode.key,
  SETTINGS.always_on_status_bar.key,
  SETTINGS.bypass_vad_for_debugging.key,
  SETTINGS.bypass_audio_encoding_for_debugging.key,
  SETTINGS.metric_system.key,
  SETTINGS.enforce_local_transcription.key,
  SETTINGS.preferred_mic.key,
  SETTINGS.screen_disabled.key,
  // glasses settings:
  SETTINGS.contextual_dashboard.key,
  SETTINGS.head_up_angle.key,
  SETTINGS.brightness.key,
  SETTINGS.auto_brightness.key,
  SETTINGS.dashboard_height.key,
  SETTINGS.dashboard_depth.key,
  // button:
  SETTINGS.button_mode.key,
  SETTINGS.button_photo_size.key,
  SETTINGS.button_video_settings.key,
  SETTINGS.button_camera_led.key,
  SETTINGS.button_max_recording_time.key,
  SETTINGS.default_wearable.key,
  SETTINGS.device_name.key,
  SETTINGS.device_address.key,
  // offline applets:
  SETTINGS.offline_captions_running.key,
  SETTINGS.gallery_mode.key,
  // SETTINGS.offline_camera_running.key,
  // notifications:
  SETTINGS.notifications_enabled.key,
  SETTINGS.notifications_blocklist.key,
]

// const PER_GLASSES_SETTINGS_KEYS: string[] = [SETTINGS.preferred_mic.key]

interface SettingsState {
  // Settings values
  settings: Record<string, any>
  // Loading states
  isInitialized: boolean
  // Actions
  setSetting: (key: string, value: any, updateServer?: boolean) => AsyncResult<void, Error>
  setManyLocally: (settings: Record<string, any>) => AsyncResult<void, Error>
  getSetting: (key: string) => any
  // loadSetting: (key: string) => AsyncResult<void, Error>
  loadAllSettings: () => AsyncResult<void, Error>
  // Utility methods
  getRestUrl: () => string
  getWsUrl: () => string
  getCoreSettings: () => Record<string, any>
}

const getDefaultSettings = () =>
  Object.keys(SETTINGS).reduce(
    (acc, key) => {
      acc[key] = SETTINGS[key].defaultValue()
      return acc
    },
    {} as Record<string, any>,
  )

const migrateSettings = () => {
  useSettingsStore.getState().setSetting(SETTINGS.enable_squircles.key, true, true)
  // Force light mode - dark mode is not complete yet
  // const devMode = useSettingsStore.getState().getSetting(SETTINGS.dev_mode.key)
  // if (!devMode) {
  // useSettingsStore.getState().setSetting(SETTINGS.theme_preference.key, "light", true)
  // }
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector((set, get) => ({
    settings: getDefaultSettings(),
    isInitialized: false,
    loadingKeys: new Set(),
    setSetting: (key: string, value: any, updateServer = true): AsyncResult<void, Error> => {
      return Res.try_async(async () => {
        const setting = SETTINGS[key]
        const originalKey = key

        if (!setting) {
          throw new Error(`SETTINGS: SET: ${originalKey} is not a valid setting!`)
        }

        if (setting.indexer) {
          key = setting.indexer(originalKey)
        }

        if (!setting.writable) {
          throw new Error(`SETTINGS: ${originalKey} is not writable!`)
        }

        // Update store immediately for optimistic UI
        console.log(`SETTINGS: SET: ${key} = ${value}`)
        set(state => ({
          settings: {...state.settings, [key]: value},
        }))

        if (setting.persist) {
          let res = await storage.save(key, value)
          if (res.is_error()) {
            throw new Error(`SETTINGS: couldn't save setting to storage: ${res.error}`)
          }

          // Sync with server if needed
          if (updateServer) {
            const result = await restComms.writeUserSettings({[key]: value})
            if (result.is_error()) {
              throw new Error(`SETTINGS: couldn't sync setting to server: ${result.error}`)
            }
          }
        }
      })
    },
    getSetting: (key: string) => {
      const state = get()
      const originalKey = key
      const setting = SETTINGS[originalKey]

      if (!setting) {
        console.error(`SETTINGS: GET: ${originalKey} is not a valid setting!`)
        return undefined
      }

      if (setting.override) {
        let override = setting.override()
        if (override !== undefined) {
          return override
        }
      }

      if (setting.indexer) {
        key = setting.indexer(originalKey)
      }

      // console.log(`GET SETTING: ${key} = ${state.settings[key]}`)

      try {
        return state.settings[key] ?? SETTINGS[originalKey].defaultValue()
      } catch (e) {
        // for dynamically created settings, we need to create a new setting in SETTINGS:
        console.log(`Failed to get setting, creating new setting:(${key}):`, e)
        SETTINGS[key] = {key: key, defaultValue: () => undefined, writable: true, saveOnServer: false, persist: true}
        return SETTINGS[key].defaultValue()
      }
    },
    // batch update many settings from the server:
    setManyLocally: (settings: Record<string, any>): AsyncResult<void, Error> => {
      return Res.try_async(async () => {
        const settingsToLoad: Record<string, any> = {}
        // if a setting should not persist, don't load it:
        for (const [key, value] of Object.entries(settings)) {
          const stg: Setting | undefined = SETTINGS[key.toLowerCase()]
          if (!stg) {
            continue
          }
          if (!stg.persist) {
            continue
          }
          settingsToLoad[key.toLowerCase()] = value
        }

        set(state => ({
          settings: {...state.settings, ...settingsToLoad},
        }))

        // save to storage:
        await Promise.all(Object.entries(settingsToLoad).map(([key, value]) => storage.save(key, value)))
      })
    },
    // loads any preferences that have been changed from the default and saved to DISK!
    loadAllSettings: (): AsyncResult<void, Error> => {
      console.log("SETTINGS: loadAllSettings()")
      return Res.try_async(async () => {
        const state = get()
        let loadedSettings: Record<string, any> = {}

        if (state.isInitialized) {
          migrateSettings()
          return undefined
        }

        for (const setting of Object.values(SETTINGS)) {
          // if the settings should not persist, don't load it:
          if (!setting.persist) {
            continue
          }

          // load all subkeys for an indexed setting:
          if (setting?.indexer) {
            console.log(`SETTINGS: LOAD: ${setting.key} with indexer!`)

            let res: Result<Record<string, unknown>, Error> = storage.loadSubKeys(setting.key)
            if (res.is_error()) {
              console.log(`SETTINGS: LOAD: ${setting.key}`, res.error)
              continue
            }

            let subKeys: Record<string, unknown> = res.value
            console.log(`SETTINGS: LOAD: ${setting.key} subkeys are set!`, subKeys)
            loadedSettings = {...loadedSettings, ...subKeys}
            continue
          }

          let res = storage.load<any>(setting.key)
          if (res.is_error()) {
            console.log(`SETTINGS: LOAD: ${setting.key} is not set!`, res.error)
            // this setting isn't set from the default, so we don't load anything
            continue
          }
          // normal key:value pair:
          let value = res.value
          console.log(`SETTINGS: LOAD: ${setting.key} = ${value.value}`)
          loadedSettings[setting.key] = value
        }

        // console.log("##############################################")
        // console.log(loadedSettings)
        // console.log("##############################################")

        set(state => ({
          isInitialized: true,
          settings: {...state.settings, ...loadedSettings},
        }))
        migrateSettings()
      })
    },
    getRestUrl: () => {
      const serverUrl = get().getSetting(SETTINGS.backend_url.key)
      console.log("GET REST URL: serverUrl:", serverUrl)
      const url = new URL(serverUrl)
      const secure = url.protocol === "https:"
      return `${secure ? "https" : "http"}://${url.hostname}:${url.port || (secure ? 443 : 80)}`
    },
    getWsUrl: () => {
      const serverUrl = get().getSetting(SETTINGS.backend_url.key)
      const url = new URL(serverUrl)
      const secure = url.protocol === "https:"
      return `${secure ? "wss" : "ws"}://${url.hostname}:${url.port || (secure ? 443 : 80)}/glasses-ws`
    },
    getCoreSettings: () => {
      const state = get()
      const coreSettings: Record<string, any> = {}
      Object.values(SETTINGS).forEach(setting => {
        if (CORE_SETTINGS_KEYS.includes(setting.key)) {
          coreSettings[setting.key] = state.getSetting(setting.key)
        }
      })
      return coreSettings
    },
  })),
)

export const useSetting = <T = any>(key: string): [T, (value: T) => AsyncResult<void, Error>] => {
  const value = useSettingsStore(state => state.getSetting(key))
  const setSetting = useSettingsStore(state => state.setSetting)
  return [value, (newValue: T) => setSetting(key, newValue)]
}
