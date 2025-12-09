export interface OtaDownloadProgress {
  status: string
  progress: number
  bytes_downloaded: number
  total_bytes: number
  error_message?: string
  timestamp: number
}

export interface OtaInstallationProgress {
  status: string
  apk_path?: string
  error_message?: string
  timestamp: number
}

export interface OtaProgress {
  download?: OtaDownloadProgress
  installation?: OtaInstallationProgress
}

export interface Glasses {
  model_name: string
  battery_level: number
  is_charging: boolean
  glasses_use_wifi: boolean
  glasses_wifi_connected: boolean
  glasses_wifi_ssid: string
  glasses_wifi_local_ip: string
  glasses_hotspot_enabled?: boolean
  glasses_hotspot_ssid?: string
  glasses_hotspot_password?: string
  glasses_hotspot_gateway_ip?: string
  case_removed: boolean
  case_open: boolean
  case_charging: boolean
  case_battery_level: number
  glasses_app_version?: string
  glasses_build_number?: string
  glasses_device_model?: string
  glasses_android_version?: string
  glasses_ota_version_url?: string
  glasses_serial_number?: string
  glasses_style?: string
  glasses_color?: string
  bluetooth_name?: string
}

export interface ButtonVideoSettings {
  width: number
  height: number
  fps: number
}

interface GlassesSettings {
  brightness: number
  auto_brightness: boolean
  head_up_angle: number | null // 0-60
  dashboard_height: number
  dashboard_depth: number
  button_mode?: string
  button_photo_size?: string // 'small' | 'medium' | 'large'
  button_video_settings?: ButtonVideoSettings
  button_camera_led: boolean
}

interface WifiConnection {
  is_connected: boolean
  ssid: string
  signal_strength: number // 0-100
}

interface GSMConnection {
  is_connected: boolean
  carrier: string
  signal_strength: number // 0-100
}

export interface CoreAuthInfo {
  core_token_owner: string
  core_token_status: string
  last_verification_timestamp: number
}

export interface CoreInfo {
  core_token: string | null
  cloud_connection_status: string
  default_wearable: string | null
  is_mic_enabled_for_frontend: boolean
  is_searching: boolean
  // protobuf_schema_version: string
  // glasses_protobuf_version: string
}

export interface CoreStatus {
  core_info: CoreInfo
  glasses_info: Glasses | null
  glasses_settings: GlassesSettings
  wifi: WifiConnection | null
  gsm: GSMConnection | null
  auth: CoreAuthInfo
  ota_progress?: OtaProgress
}

export class CoreStatusParser {
  static defaultStatus: CoreStatus = {
    core_info: {
      cloud_connection_status: "DISCONNECTED",
      core_token: null,
      is_mic_enabled_for_frontend: false,
      default_wearable: null,
      is_searching: false,
    },
    glasses_info: null,
    glasses_settings: {
      brightness: 50,
      auto_brightness: false,
      dashboard_height: 4,
      dashboard_depth: 5,
      head_up_angle: 30,
      button_mode: "photo",
      button_photo_size: "medium",
      button_video_settings: {
        width: 1280,
        height: 720,
        fps: 30,
      },
      button_camera_led: true,
    },
    wifi: {is_connected: false, ssid: "", signal_strength: 0},
    gsm: {is_connected: false, carrier: "", signal_strength: 0},
    auth: {
      core_token_owner: "",
      core_token_status: "",
      last_verification_timestamp: 0,
    },
  }

  static mockStatus: CoreStatus = {
    core_info: {
      cloud_connection_status: "CONNECTED",
      core_token: "1234567890",
      is_mic_enabled_for_frontend: false,
      default_wearable: "evenrealities_g1",
      is_searching: false,
    },
    glasses_info: {
      model_name: "Even Realities G1",
      battery_level: 60,
      is_charging: false,
      glasses_use_wifi: false,
      glasses_wifi_connected: false,
      glasses_wifi_ssid: "",
      glasses_wifi_local_ip: "",
      glasses_hotspot_enabled: false,
      glasses_hotspot_ssid: "",
      glasses_hotspot_password: "",
      glasses_hotspot_gateway_ip: "",
      case_removed: true,
      case_open: true,
      case_charging: false,
      case_battery_level: 0,
      glasses_serial_number: "ER-G1-2024-001234",
      glasses_style: "Round",
      glasses_color: "Green",
    },
    glasses_settings: {
      brightness: 87,
      auto_brightness: false,
      dashboard_height: 4,
      dashboard_depth: 5,
      head_up_angle: 20,
      button_mode: "photo",
      button_photo_size: "medium",
      button_video_settings: {
        width: 1280,
        height: 720,
        fps: 30,
      },
      button_camera_led: true,
    },
    wifi: {is_connected: true, ssid: "TP-LINK69", signal_strength: 100},
    gsm: {is_connected: false, carrier: "", signal_strength: 0},
    auth: {
      core_token_owner: "",
      core_token_status: "",
      last_verification_timestamp: 0,
    },
  }

  static parseStatus(data: any): CoreStatus {
    if (data && "core_status" in data) {
      const status = data.core_status
      const coreInfo = status.core_info ?? {}
      const glassesInfo = status.connected_glasses ?? {}
      const authInfo = status.auth ?? {}
      const otaProgress = status.ota_progress ?? {}

      // First determine if we have connected glasses in the status
      const hasConnectedGlasses = status.connected_glasses && status.connected_glasses.model_name

      return {
        core_info: {
          core_token: coreInfo.core_token ?? null,
          cloud_connection_status: coreInfo.cloud_connection_status ?? "DISCONNECTED",
          default_wearable:
            hasConnectedGlasses && !coreInfo.default_wearable
              ? status.connected_glasses.model_name
              : (coreInfo.default_wearable ?? null),
          is_mic_enabled_for_frontend: coreInfo.is_mic_enabled_for_frontend ?? false,
          is_searching: coreInfo.is_searching ?? false,
        },
        glasses_info: status.connected_glasses
          ? {
              model_name: glassesInfo.model_name,
              battery_level: glassesInfo.battery_level,
              is_charging: glassesInfo.is_charging ?? false,
              glasses_use_wifi: glassesInfo.glasses_use_wifi || false,
              glasses_wifi_connected: glassesInfo.glasses_wifi_connected || false,
              glasses_wifi_ssid: glassesInfo.glasses_wifi_ssid || "",
              glasses_wifi_local_ip: glassesInfo.glasses_wifi_local_ip || "",
              glasses_hotspot_enabled: glassesInfo.glasses_hotspot_enabled || false,
              glasses_hotspot_ssid: glassesInfo.glasses_hotspot_ssid || "",
              glasses_hotspot_password: glassesInfo.glasses_hotspot_password || "",
              glasses_hotspot_gateway_ip: glassesInfo.glasses_hotspot_gateway_ip || "",
              case_removed: glassesInfo.case_removed ?? true,
              case_open: glassesInfo.case_open ?? true,
              case_charging: glassesInfo.case_charging ?? false,
              case_battery_level: glassesInfo.case_battery_level ?? 0,
              glasses_app_version: glassesInfo.glasses_app_version,
              glasses_build_number: glassesInfo.glasses_build_number,
              glasses_device_model: glassesInfo.glasses_device_model,
              glasses_android_version: glassesInfo.glasses_android_version,
              glasses_ota_version_url:
                glassesInfo.glasses_ota_version_url || "https://ota.mentraglass.com/live_version.json",
              glasses_serial_number: glassesInfo.glasses_serial_number,
              glasses_style: glassesInfo.glasses_style,
              glasses_color: glassesInfo.glasses_color,
              bluetooth_name: glassesInfo.bluetooth_name,
            }
          : null,
        glasses_settings: status.glasses_settings
          ? {
              brightness: status.glasses_settings.brightness ?? 50,
              auto_brightness: status.glasses_settings.auto_brightness ?? false,
              dashboard_height: status.glasses_settings.dashboard_height ?? 4,
              dashboard_depth: status.glasses_settings.dashboard_depth ?? 5,
              head_up_angle: status.glasses_settings.head_up_angle ?? 30,
              button_mode: status.glasses_settings.button_mode ?? "photo",
              button_photo_size: status.glasses_settings.button_photo_size ?? "medium",
              button_video_settings: status.glasses_settings.button_video_settings ?? {
                width: 1280,
                height: 720,
                fps: 30,
              },
              button_camera_led: status.glasses_settings.button_camera_led,
            }
          : {
              brightness: 50,
              auto_brightness: false,
              dashboard_height: 4,
              dashboard_depth: 5,
              head_up_angle: 30,
              button_mode: "photo",
              button_photo_size: "medium",
              button_video_settings: {
                width: 1280,
                height: 720,
                fps: 30,
              },
              button_camera_led: false,
            },
        wifi: status.wifi ?? CoreStatusParser.defaultStatus.wifi,
        gsm: status.gsm ?? CoreStatusParser.defaultStatus.gsm,
        auth: {
          core_token_owner: authInfo.core_token_owner,
          core_token_status: authInfo.core_token_status,
          last_verification_timestamp: authInfo.last_verification_timestamp,
        },
        ota_progress:
          otaProgress.download || otaProgress.installation
            ? {
                download: otaProgress.download,
                installation: otaProgress.installation,
              }
            : undefined,
      }
    }
    return CoreStatusParser.defaultStatus
  }
}

export default CoreStatusParser
