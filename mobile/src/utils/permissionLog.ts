import {Platform} from "react-native"

/** What a permission alert is about. */
export type PermissionKind =
  | "local_network"
  | "bluetooth"
  | "camera"
  | "microphone"
  | "photo_library"
  | "location"
  | "notifications"
  | "calendar"
  | "permissions"

/** The kind for a permission feature's English name, such as "Background Location". */
export function permissionKind(name: string): PermissionKind {
  const lower = name.toLowerCase()
  if (lower.includes("notification")) return "notifications"
  if (lower.includes("camera")) return "camera"
  if (lower.includes("microphone")) return "microphone"
  if (lower.includes("calendar")) return "calendar"
  if (lower.includes("location")) return "location"
  if (lower.includes("bluetooth")) return "bluetooth"
  if (lower.includes("photo")) return "photo_library"
  return "permissions"
}

function describe(systemAnswer: unknown): string {
  if (typeof systemAnswer === "string") return systemAnswer
  try {
    return JSON.stringify(systemAnswer) ?? String(systemAnswer)
  } catch {
    return String(systemAnswer)
  }
}

/**
 * Logs the system's raw answer that made the app show a permission alert, so a reader can tell the app's claim
 * from the system's state. One greppable line, also in the iOS and Mac unified log, where the JS console is not:
 * `[Permission] <kind>: <system answer> → alert <alert> at <ISO time>`. Pass statuses only, never personal data.
 */
export function logPermissionAlert(kind: PermissionKind, systemAnswer: unknown, alert: string): void {
  const line = `[Permission] ${kind}: ${describe(systemAnswer)} → alert ${alert} at ${new Date().toISOString()}`
  console.log(line)
  if (Platform.OS !== "ios") return
  try {
    const native = require("expo-modules-core").requireOptionalNativeModule("MentraGlassesMediaRelay") as {
      logPermission?: (line: string) => void
    } | null
    native?.logPermission?.(line)
  } catch {
    // Logging must never break the alert.
  }
}
