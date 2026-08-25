import {getTimeZone} from "react-native-localize"
import {AsyncResult, result as Res, Result} from "typesafe-ts"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

import {storage} from "../utils/storage"
import {getBluetoothSettingKeysForDevice} from "./bluetoothSettingKeys"
import {useGlassesStore} from "./glasses"

export {MENTRA_LIVE_SETTING_KEYS, getBluetoothSettingKeysForDevice} from "./bluetoothSettingKeys"

export interface Setting {
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
  // Pairing-identity keys are NATIVE-authoritative: the native layer writes
  // them on pairing success (handleDeviceReady) / forget and echoes them down
  // via save_setting; JS鈫抧ative they travel only in the explicit SEEDS
  // (hydration, pre-connect, post-demotion, abandon re-seed) — never the
  // change-push and never the on-connect replay, whose mid-relay snapshot can
  // overwrite a just-promoted identity. PAIRING_IDENTITY_KEYS is derived from
  // this flag so the sync exclusions can't drift from the descriptors.
  nativeAuthoritative?: true
  /**
   * Clear this setting when the build's environment changes.
   *
   * A persisted override normally outranks both the build's env and the
   * compiled default, which is right within one environment: a developer's
   * METRO_AUTO pin should survive a rebuild. It is wrong across environments,
   * where an override pinned under a dev build would silently follow the
   * install onto a store build pointed at production.
   *
   * Note this keys off the build's environment label, so it does NOT fire on a
   * TestFlight to App Store promotion: that ships the same binary with the same
   * label. Promotion is safe because the publishing lane bakes prod URLs, not
   * because this reset runs. See the resolution block in loadSettings.
   *
   * Absent means the value is never invalidated automatically.
   */
  resetOnBuildEnvChange?: true
}

export const SETTINGS: Record<string, Setting> = {
  // feature flags / mantle settings:
  dev_mode: {key: "dev_mode", defaultValue: () => __DEV__, writable: true, saveOnServer: true, persist: true}, // deprecated
  debug_mode: {key: "debug_mode", defaultValue: () => __DEV__, writable: true, saveOnServer: true, persist: true},
  miniapp_store_preview_enabled: {
    key: "miniapp_store_preview_enabled",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  android_notification_listener_enabled: {
    key: "android_notification_listener_enabled",
    // Operational kill switch. The listener now runs in a guarded lightweight
    // process, so normal installs can safely capture notifications by default.
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  super_mode: {key: "super_mode", defaultValue: () => false, writable: true, saveOnServer: true, persist: true},
  appearance_menu_enabled: {
    key: "appearance_menu_enabled",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  app_boot_extra_info: {
    key: "app_boot_extra_info",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  miniapp_dev_mode: {
    key: "miniapp_dev_mode",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  enable_squircles: {
    key: "enable_squircles",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  android_blur: {
    key: "android_blur",
    defaultValue: () => {
      return false
    },
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  android_inner_shadow: {
    key: "android_inner_shadow",
    defaultValue: () => {
      return false
    },
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  ios_glass_effect: {
    key: "ios_glass_effect",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  ios_app_switcher_bottom_swipe: {
    key: "ios_app_switcher_bottom_swipe",
    defaultValue: () => false,
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
  debug_navigation_history: {
    key: "debug_navigation_history",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  debug_core_status_bar: {
    key: "debug_core_status_bar",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // Mentra Nex feature flags (off by default; toggled from Nex Developer Settings).
  // When on, the Nex display skips ASCII-only text sanitization so CJK/Chinese
  // captions render on glasses. Synced to the Bluetooth SDK via BLUETOOTH_SETTING_KEYS.
  nex_chinese_captions: {
    key: "nex_chinese_captions",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // When on, LC3 audio received from Nex glasses is played back (Android only).
  // Local-only dev toggle: defaults off and never synced to the cloud account
  // (saveOnServer: false); persists locally so it survives app restarts.
  // Key renamed from the legacy `nex_audio_playback` so stale server/local
  // values (saved back when this was saveOnServer:true) can't re-enable it.
  nex_lc3_audio_playback: {
    key: "nex_lc3_audio_playback",
    defaultValue: () => false,
    writable: true,
    saveOnServer: false,
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
  // Cloud V2 endpoint OVERRIDES. Empty = no override; cloudClient's resolveUrl
  // owns the full precedence (override -> env -> Metro-derived dev default).
  // The value may be an explicit URL or the METRO_AUTO sentinel ("my dev
  // laptop", resolved live from Metro so it survives network changes). Never
  // bake an env var or a personal LAN IP into the default here: that makes the
  // override branch always-truthy and strands devs on a stale address.
  cloud_core_url: {
    key: "cloud_core_url",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    resetOnBuildEnvChange: true,
  },
  cloud_runtime_url: {
    key: "cloud_runtime_url",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    resetOnBuildEnvChange: true,
  },
  // Bookmarked Cloud V2 endpoint pairs. Each entry is {label, coreUrl,
  // runtimeUrl} — core + runtime are saved together because they are always
  // applied as a matched set (presets fill both; Save & Test verifies both).
  saved_cloud_url_pairs: {
    key: "saved_cloud_url_pairs",
    defaultValue: () => [],
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  // Developer override for the ASG OTA manifest URL. null/empty = no override;
  // the normal selection applies (legacy-glasses gate, EXPO_PUBLIC_ASG_OTA_VERSION_URL,
  // glasses-reported URL, then production). See resolveOtaManifestUrl.
  ota_version_url: {
    key: "ota_version_url",
    defaultValue: () => null,
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  saved_ota_version_urls: {
    key: "saved_ota_version_urls",
    defaultValue: () => [],
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  reconnect_on_app_foreground: {
    key: "reconnect_on_app_foreground",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  location_tier: {key: "location_tier", defaultValue: () => "", writable: true, saveOnServer: true, persist: true},
  // Volatile bearer synced to Bluetooth for glasses-side Cloud V2 calls. The
  // key name is kept for BLE compatibility, but the value must never be loaded
  // from or saved to the legacy Cloud V1 settings store.
  core_token: {key: "core_token", defaultValue: () => "", writable: true, saveOnServer: false, persist: false},
  auth_email: {key: "auth_email", defaultValue: () => "", writable: true, saveOnServer: false, persist: true},
  // Pairing identity is per-phone, not per-account: two phones on one account
  // can be paired to different glasses, so none of these keys may sync to the
  // server (saveOnServer: false — a stale server copy resurrecting a local
  // pairing identity is exactly the desync this group's flags prevent).
  //
  // Two-phase identity: pending_wearable is the model the user last STARTED
  // pairing (written at selection, rendered as a finish-pairing card);
  // default_wearable + device_name + device_address are only promoted by the
  // native layer when pairing actually succeeds (handleDeviceReady).
  // pending_wearable persists so an abandoned selection still shows its
  // finish-pairing card after an app restart.
  pending_wearable: {
    key: "pending_wearable",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  default_wearable: {
    key: "default_wearable",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  device_name: {
    key: "device_name",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  device_address: {
    key: "device_address",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  project_name: {
    key: "project_name",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  default_controller: {
    key: "default_controller",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  pending_controller: {
    key: "pending_controller",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  controller_device_name: {
    key: "controller_device_name",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  controller_address: {
    key: "controller_address",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
    nativeAuthoritative: true,
  },
  // ui state:
  home_background: {
    key: "home_background",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  theme_preference: {
    key: "theme_preference",
    defaultValue: () => "light",
    // Force light mode - i mode is not complete yet
    // override: () => "light",
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
  onboarding_live_completed: {
    key: "onboarding_live_completed",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  onboarding_os_completed: {
    key: "onboarding_os_completed",
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

  // Bluetooth SDK settings:
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
  // The Mentra App intentionally preserves Mentra Live's historical VAD-on
  // product default. Standalone public Bluetooth SDK hosts default VAD off so
  // their microphone audio remains continuous.
  voice_activity_detection_enabled: {
    key: "voice_activity_detection_enabled",
    defaultValue: () => true,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // Mentra Live center-mic loudness / "Barrier" gate (cs_swit type 10). Default on.
  loudness_gate_enabled: {
    key: "loudness_gate_enabled",
    defaultValue: () => true,
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
  // Legacy cloud/mobile setting name. Locally it maps to glasses-side Voice Activity Detection.
  bypass_vad_for_debugging: {
    key: "bypass_vad_for_debugging",
    defaultValue: () => false,
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
  twelve_hour_time: {
    key: "twelve_hour_time",
    defaultValue: () => true,
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
  // LC3 audio quality setting (frame size in bytes)
  // 20 = 16kbps (low bandwidth), 40 = 32kbps (balanced), 60 = 48kbps (high quality)
  lc3_frame_size: {
    key: "lc3_frame_size",
    defaultValue: () => 60,
    writable: true,
    saveOnServer: false,
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
  use_native_dashboard: {
    key: "use_native_dashboard",
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
    defaultValue: () => 2,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  menu_apps: {
    key: "menu_apps",
    defaultValue: () => null,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  calendar_events: {
    key: "calendar_events",
    defaultValue: () => [],
    writable: true,
    saveOnServer: false,
    persist: false,
  },
  // button settings
  // Legacy persisted/cloud key; hardware behavior is now controlled by gallery_mode plus capture settings.
  button_mode: {key: "button_mode", defaultValue: () => "photo", writable: true, saveOnServer: true, persist: true},
  button_photo_size: {
    key: "button_photo_size",
    defaultValue: () => "max",
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
  button_max_recording_time: {
    key: "button_max_recording_time",
    defaultValue: () => 10,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  camera_fov: {
    key: "camera_fov",
    defaultValue: () => ({fov: 118, roi_position: 0}),
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  media_post_processing: {
    key: "media_post_processing",
    defaultValue: () => false,
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
  // Runtime flag: coordinator flips this on when cloud STT has failed and fallback is active.
  // Native GlassesStore watches it to gate PCM 鈫?Sherpa feeding. Not user-facing.
  local_stt_fallback_active: {
    key: "local_stt_fallback_active",
    defaultValue: () => false,
    writable: true,
    saveOnServer: false,
    persist: false,
  },
  gallery_mode: {key: "gallery_mode", defaultValue: () => true, writable: true, saveOnServer: true, persist: true},
  gallery_sync_explained: {
    key: "gallery_sync_explained",
    defaultValue: () => false,
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  offline_camera_running: {
    key: "offline_camera_running",
    defaultValue: () => false,
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  // offline translation
  offline_translation_running: {
    key: "offline_translation_running",
    defaultValue: () => false,
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  offline_translation_source: {
    key: "offline_translation_source",
    defaultValue: () => "en",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  offline_translation_target: {
    key: "offline_translation_target",
    defaultValue: () => "es",
    writable: true,
    saveOnServer: true,
    persist: true,
  },
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
  notifications_blocklist: {
    key: "notifications_blocklist",
    defaultValue: () => [],
    writable: true,
    saveOnServer: true,
    persist: true,
  },
  // Cached required version from server - used to enforce updates even when offline
  cached_required_version: {
    key: "cached_required_version",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
  },
  // OTA update dismissal - stores the version code user dismissed (not persisted so resets on app restart)
  dismissed_ota_version: {
    key: "dismissed_ota_version",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: false,
  },
  // Contact email for feedback (persisted for Apple private relay users)
  contact_email: {
    key: "contact_email",
    defaultValue: () => "",
    writable: true,
    saveOnServer: false,
    persist: true,
  },
} as const

export const OFFLINE_APPLETS: string[] = ["com.mentra.livecaptions", "com.mentra.camera"]

// These settings are automatically synced to the Bluetooth SDK.
// Keep this list hardware-facing; app/UI/cloud-only preferences should stay in JS/Crust.
export const BLUETOOTH_SETTING_KEYS: string[] = [
  // Bluetooth settings:
  SETTINGS.sensing_enabled.key,
  SETTINGS.power_saving_mode.key,
  SETTINGS.voice_activity_detection_enabled.key,
  SETTINGS.loudness_gate_enabled.key,
  SETTINGS.lc3_frame_size.key,
  SETTINGS.preferred_mic.key,
  SETTINGS.screen_disabled.key,
  SETTINGS.auth_email.key,
  SETTINGS.core_token.key,
  // glasses settings:
  SETTINGS.contextual_dashboard.key,
  SETTINGS.head_up_angle.key,
  SETTINGS.brightness.key,
  SETTINGS.auto_brightness.key,
  SETTINGS.dashboard_height.key,
  SETTINGS.dashboard_depth.key,
  SETTINGS.menu_apps.key,
  SETTINGS.calendar_events.key,
  SETTINGS.use_native_dashboard.key,
  SETTINGS.twelve_hour_time.key,
  SETTINGS.metric_system.key,
  // button:
  SETTINGS.button_photo_size.key,
  // Legacy MentraLive native code reads the object form when syncing video settings.
  SETTINGS.button_video_settings.key,
  SETTINGS.button_max_recording_time.key,
  SETTINGS.camera_fov.key,
  // device / pairing:
  SETTINGS.pending_wearable.key,
  SETTINGS.default_wearable.key,
  SETTINGS.device_name.key,
  SETTINGS.device_address.key,
  SETTINGS.project_name.key,
  SETTINGS.default_controller.key,
  SETTINGS.pending_controller.key,
  SETTINGS.controller_device_name.key,
  SETTINGS.controller_address.key,
  // offline applets:
  SETTINGS.offline_mode.key,
  // Runtime flag flipped by LocalSttFallbackCoordinator. Native reads it from
  // GlassesStore to gate PCM 鈫?Sherpa feeding in handlePcm and to keep the
  // mic on while local STT is the active engine.
  SETTINGS.local_stt_fallback_active.key,
  SETTINGS.gallery_mode.key,
  // Mentra Nex feature flags:
  SETTINGS.nex_chinese_captions.key,
  SETTINGS.nex_lc3_audio_playback.key,
]

// Pairing identity is NATIVE-authoritative: the native layer writes it on
// pairing success (handleDeviceReady) / forget and echoes it down via
// save_setting; JS persists those echoes. JS鈫抧ative, identity travels ONLY in
// the explicit full seeds (device-store hydration, pre-connect push,
// post-demotion re-push) — never in the change-push subscription. Relaying an
// echoed identity change back up would make the sync bidirectional with loop
// gain 1: two identity values in flight (e.g. a boot demotion crossing a
// native promotion) then chase each other through push鈫抋pply鈫抏cho鈫抪ush
// forever, flapping the UI.
//
// Derived from the `nativeAuthoritative` descriptor flag (not maintained as a
// parallel list) so the change-push exclusion in GlassesSettingsSync can't
// drift from the setting declarations.
export const PAIRING_IDENTITY_KEYS: string[] = Object.values(SETTINGS)
  .filter((setting) => setting.nativeAuthoritative)
  .map((setting) => setting.key)

// const PER_GLASSES_SETTINGS_KEYS: string[] = [SETTINGS.preferred_mic.key]

export interface SettingsState {
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
  getBluetoothSettings: () => Record<string, any>
  resetAllSettingsLocally: () => void
}

const getDefaultSettings = () =>
  Object.keys(SETTINGS).reduce(
    (acc, key) => {
      acc[key] = SETTINGS[key].defaultValue()
      return acc
    },
    {} as Record<string, any>,
  )

// Single-flight for loadAllSettings: the host fires it at module load and
// engine.start()'s device-store hydration awaits it — without the memo the
// second caller runs a duplicate full disk load while the first is still in
// flight. Cleared on failure so a later call can retry.
let loadAllSettingsInFlight: AsyncResult<void, Error> | null = null

function printableSettingValue(key: string, value: unknown): string {
  return key.includes("token") || key.includes("email") ? "<redacted>" : JSON.stringify(value)
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector((set, get) => ({
    settings: getDefaultSettings(),
    isInitialized: false,
    loadingKeys: new Set(),
    setSetting: (key: string, value: any, _updateServer = true): AsyncResult<void, Error> => {
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
        console.log(`SETTINGS: SET: ${key} = ${printableSettingValue(key, value)}`)
        set((state) => ({
          settings: {...state.settings, [key]: value},
        }))

        if (setting.persist) {
          let res = await storage.save(key, value)
          if (res.is_error()) {
            throw new Error(`SETTINGS: couldn't save setting to storage: ${res.error}`)
          }

          // Cloud V1 per-change server sync removed with the V1 ripout (issue
          // #3392). Settings are local-first until a V2 sync lands; the
          // saveOnServer flags are retained as intent markers for that work.
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
        const raw = state.settings[key] ?? SETTINGS[originalKey].defaultValue()
        return raw
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
        // console.log("SETTINGS: SET MANY LOCALLY: ", settingsToLoad)

        set((state) => ({
          settings: {...state.settings, ...settingsToLoad},
        }))

        // save to storage:
        await Promise.all(Object.entries(settingsToLoad).map(([key, value]) => storage.save(key, value)))
      })
    },
    // loads any preferences that have been changed from the default and saved to DISK!
    loadAllSettings: (): AsyncResult<void, Error> => {
      console.log("SETTINGS: loadAllSettings()")
      if (loadAllSettingsInFlight) {
        return loadAllSettingsInFlight
      }
      const inFlight = Res.try_async(async () => {
        const state = get()
        let loadedSettings: Record<string, any> = {}

        if (state.isInitialized) {
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
          // res.value IS the stored value; logging value.value printed
          // "undefined" for every loaded setting and disguised present
          // values as missing. Redact token- and email-bearing keys: console
          // logs are uploaded in bug-report artifacts (same keys
          // diagnosticContext's SENSITIVE_SETTINGS_KEYS strips, minus an
          // import that would cycle stores <-> utils).
          console.log(`SETTINGS: LOAD: ${setting.key} = ${printableSettingValue(setting.key, value)}`)
          loadedSettings[setting.key] = value
        }

        // console.log("##############################################")
        // console.log(loadedSettings)
        // console.log("##############################################")

        set((state) => ({
          isInitialized: true,
          settings: {...state.settings, ...loadedSettings},
        }))

        // This hidden debug switch originally shipped default-off while the
        // notification-listener cold-start ANR was being investigated. Now
        // that the listener runs in its own guarded process, migrate existing
        // installs to the new default once; later explicit debug changes still
        // persist normally.
        // Reset the cloud backend override when the build's environment changes.
        //
        // cloud_core_url / cloud_runtime_url are persist:true and outrank both
        // the build's env and the compiled default (see resolveUrl in
        // cloudClient.ts). That is what we want inside one environment: a
        // developer's METRO_AUTO pin should survive a rebuild. It is wrong
        // across environments.
        //
        // The concrete case is an install that moves BETWEEN environments: an
        // internal tester running a dev build with a pinned override who then
        // installs the store build. The override outranks that build's prod
        // URLs, so without this they keep talking to dev with nothing
        // surfacing it.
        //
        // Note what this deliberately does NOT do, because the distinction is
        // easy to get backwards. TestFlight and the App Store receive the SAME
        // binary, so promotion does not change EXPO_PUBLIC_BUILD_ENV and this
        // reset never fires on it. Promotion is safe for a different reason:
        // the publishing lane bakes the selected release cloud environment, and
        // production promotes the already-tested binary. The same holds for
        // Android beta-track to production.
        //
        // The residual gap is therefore an override pinned while already on a
        // prod-labelled build, which no label comparison can see. That is a
        // deliberate limit: reaching it means typing a URL into a dev-only
        // screen, VersionInfo renders the current value, and the same screen
        // clears it.
        //
        // Comparing the baked EXPO_PUBLIC_BUILD_ENV against the last one seen
        // on this device covers those environment switches and fresh installs
        // without touching the setting write path. A reinstall needs no
        // handling: it drops the marker and the override together
        // (android:allowBackup="false", and iOS deletes the container).
        const BUILD_ENV_KEY = "settings.lastBuildEnv"
        const buildEnv = (process.env.EXPO_PUBLIC_BUILD_ENV ?? "dev").trim() || "dev"
        const lastBuildEnv = storage.load<string>(BUILD_ENV_KEY)
        const previousBuildEnv = lastBuildEnv.is_error() ? undefined : lastBuildEnv.value
        if (previousBuildEnv !== buildEnv) {
          // Clear when there is no marker yet, not just on a recorded change.
          // The first build carrying this code meets every existing install
          // with previousBuildEnv === undefined, and those are exactly the
          // installs that may hold an override set before the pin existed --
          // the population this is here to repair. Treating "no marker" as a
          // fresh install would record the marker and never look again. A
          // genuinely fresh install has nothing persisted, so the clear below
          // writes each default over itself and costs nothing.
          //
          // Driven by the descriptors rather than a hardcoded key list, so a
          // setting that needs this behaviour declares it in one place and
          // cannot be missed here.
          const scoped = Object.values(SETTINGS).filter((setting) => setting.resetOnBuildEnvChange)
          console.log(
            `SETTINGS: build env ${previousBuildEnv ?? "(none recorded)"} -> ${buildEnv}, ` +
              `clearing ${scoped.length} build-scoped setting(s)`,
          )
          let allCleared = true
          for (const setting of scoped) {
            const cleared = await get().setSetting(setting.key, setting.defaultValue(), false)
            if (cleared.is_error()) {
              allCleared = false
              console.log(`SETTINGS: could not clear ${setting.key}:`, cleared.error)
            }
          }
          // Advance the marker only once the reset actually landed. Recording
          // it after a failed write would retire the retry and leave the stale
          // override for the life of the install; leaving it unset costs one
          // repeated attempt per launch until a write succeeds.
          if (allCleared) {
            storage.save(BUILD_ENV_KEY, buildEnv)
          }
        }

        const NOTIFICATION_LISTENER_MIGRATION_KEY = "migration:android_notification_listener_default_on_v1"
        const notificationListenerMigrationDone = storage.load<boolean>(NOTIFICATION_LISTENER_MIGRATION_KEY)
        if (notificationListenerMigrationDone.is_error() || !notificationListenerMigrationDone.value) {
          const result = await get().setSetting(SETTINGS.android_notification_listener_enabled.key, true, false)
          if (result.is_error()) {
            console.log("SETTINGS: notification listener migration failed:", result.error)
          } else {
            storage.save(NOTIFICATION_LISTENER_MIGRATION_KEY, true)
          }
        }

        // One-time migration: force android_blur=false for existing users.
        // The setting's default is already false; this migration covers users
        // who explicitly opted into Android blur effects before we discovered
        // they're a major source of frame drops on cheap Android phones.
        // The dimezisBlurViewSdk31Plus blur each costs ~5-10ms/frame; with
        // multiple blurs on home (top fade + AppSwitcherButton x2) a low-end
        // device misses the 16ms budget consistently. Users can turn it back
        // on under Settings 鈫?Appearance once we've optimized further.
        //
        // The setSetting call also pushes to the server (saveOnServer: true)
        // so the server-stored value flips too — otherwise the next sync
        // from the user's server-stored prefs would re-enable blur.
        // Best-effort: a server failure (offline, 5xx) shouldn't block boot;
        // we still mark the migration done locally so we don't loop.
        const MIGRATION_KEY = "migration:android_blur_default_false_v1"
        const migrationDone = storage.load<boolean>(MIGRATION_KEY)
        if (migrationDone.is_error() || !migrationDone.value) {
          const current = get().getSetting(SETTINGS.android_blur.key)
          if (current === true) {
            const result = await get().setSetting(SETTINGS.android_blur.key, false, true)
            if (result.is_error()) {
              // Server push failed (offline / 5xx). Local storage was still
              // updated, so the user immediately gets the new behavior. The
              // server-side stale `true` will be overwritten the next time
              // the user opens Appearance settings and the auto-sync runs.
              console.log("SETTINGS: android_blur migration server-push failed:", result.error)
            }
          }
          // Mark done unconditionally — even on server-push failure we don't
          // want to retry the migration on every boot. The local value is
          // already correct.
          storage.save(MIGRATION_KEY, true)
        }

        // The old camera default cropped the sensor to 102掳. Move existing
        // default-shaped values to the full 118掳 sensor once; named miniapp
        // requests for the 102掳 "standard" preset remain available.
        const CAMERA_FOV_MIGRATION_KEY = "migration:camera_fov_full_sensor_v1"
        const cameraFovMigrationDone = storage.load<boolean>(CAMERA_FOV_MIGRATION_KEY)
        if (cameraFovMigrationDone.is_error() || !cameraFovMigrationDone.value) {
          const current = get().getSetting(SETTINGS.camera_fov.key) as {fov?: number; roi_position?: number} | undefined
          let migrationSucceeded = true
          if (current?.fov === 102 && (current.roi_position ?? 0) === 0) {
            const result = await get().setSetting(SETTINGS.camera_fov.key, {fov: 118, roi_position: 0}, true)
            if (result.is_error()) {
              console.log("SETTINGS: camera FOV migration failed:", result.error)
              migrationSucceeded = false
            }
          }
          // Unlike the blur migration above, a failed camera set may leave the
          // local value unchanged. Only mark this migration complete once the
          // desired value was applied so a transient failure retries on boot.
          if (migrationSucceeded) storage.save(CAMERA_FOV_MIGRATION_KEY, true)
        }
      })
      loadAllSettingsInFlight = inFlight
      void Promise.resolve(inFlight).then((result) => {
        if (result.is_error()) {
          loadAllSettingsInFlight = null
        }
      })
      return inFlight
    },
    getBluetoothSettings: () => {
      const state = get()
      // Device-model-filtered key set (wire v2): Mentra Live (no display) gets
      // the reduced MENTRA_LIVE_SETTING_KEYS; display glasses get the full set.
      const deviceModel = useGlassesStore.getState().deviceModel || state.getSetting(SETTINGS.default_wearable.key)
      const keys = getBluetoothSettingKeysForDevice(deviceModel, BLUETOOTH_SETTING_KEYS)
      const bluetoothSettings: Record<string, any> = {}
      for (const key of keys) {
        const value = state.getSetting(key)
        if (key === SETTINGS.core_token.key && (typeof value !== "string" || value.trim().length === 0)) {
          continue
        }
        bluetoothSettings[key] = value
      }
      return bluetoothSettings
    },
    resetAllSettingsLocally: () => {
      set((_state) => ({
        settings: getDefaultSettings(),
        isInitialized: true,
      }))
    },
  })),
)

export const useSetting = <T = any>(key: string): [T, (value: T) => AsyncResult<void, Error>] => {
  const value = useSettingsStore((state) => state.getSetting(key))
  const setSetting = useSettingsStore((state) => state.setSetting)
  return [value, (newValue: T) => setSetting(key, newValue)]
}
