// User-facing one-liners for the wizard / interactive prompts. Kept separate
// so manifest.ts can stay UX-string-free.

import {AllowedHardwareType, AllowedPermission} from "./manifest.js"

const PERMISSION_HINTS: Record<AllowedPermission, string> = {
  MICROPHONE: "Required for transcription, audio chunks, voice activity detection",
  CAMERA: "Required for taking photos via session.camera.takePhoto()",
  CALENDAR: "Required to receive calendar event subscriptions",
  LOCATION: "Required for foreground location updates",
  BACKGROUND_LOCATION: "Required for location updates while app is backgrounded",
  READ_NOTIFICATIONS: "Required to receive phone notifications",
  POST_NOTIFICATIONS: "Required to post system notifications from the miniapp",
}

const HARDWARE_HINTS: Record<AllowedHardwareType, string> = {
  CAMERA: "Glasses-side camera; required for photo capture",
  DISPLAY: "Glasses display; required to show layouts",
  MICROPHONE: "Glasses-side mic; required for capture",
  SPEAKER: "Audio output through the glasses",
  IMU: "Head position / motion sensor",
  BUTTON: "Physical button on the glasses",
  LIGHT: "RGB LED indicator",
  WIFI: "Glasses Wi-Fi capability (e.g. for streaming)",
}

export function permissionDescription(p: AllowedPermission): string {
  return PERMISSION_HINTS[p] ?? ""
}

export function hardwareDescription(h: AllowedHardwareType): string {
  return HARDWARE_HINTS[h] ?? ""
}
