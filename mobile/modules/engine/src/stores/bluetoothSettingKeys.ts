import {DeviceTypes} from "../types"

/** Mentra Live has no display — omit dashboard/brightness keys from BLE sync. */
export const MENTRA_LIVE_SETTING_KEYS: string[] = [
  "sensing_enabled",
  "lc3_frame_size",
  "preferred_mic",
  "voice_activity_detection_enabled",
  "loudness_gate_enabled",
  "core_token",
  "auth_email",
  "button_photo_size",
  "button_video_settings",
  "button_max_recording_time",
  "camera_fov",
  "offline_mode",
  "local_stt_fallback_active",
  "gallery_mode",
  "default_wearable",
  "pending_wearable",
  "device_name",
  "device_address",
  "default_controller",
  "pending_controller",
  "controller_device_name",
  "controller_address",
]

function isMentraLiveDevice(model: string | undefined): boolean {
  return model === DeviceTypes.LIVE || model === "Mentra Live"
}

export function getBluetoothSettingKeysForDevice(
  deviceModel: string | undefined,
  fullKeys: string[],
): string[] {
  return isMentraLiveDevice(deviceModel) ? MENTRA_LIVE_SETTING_KEYS : fullKeys
}
