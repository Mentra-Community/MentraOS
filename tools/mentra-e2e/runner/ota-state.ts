import type {Snapshot} from "./driver"

export class OtaValidationError extends Error {}
export class OtaHardwareUnavailable extends Error {
  constructor(
    readonly kind: "transport" | "boot",
    message: string,
  ) {
    super(message)
  }
}

export function normalizeFirmware(version: string) {
  if (typeof version !== "string" || !/^(?:MentraLive_)?\d{8}(?:\.\d{1,9})?$/.test(version))
    throw new OtaValidationError("Invalid firmware version in OTA route or observation")
  return "MentraLive_" + version.split("_").at(-1)
}

/** Follow the app's first-matching patch order, never unrelated manifest branches. */
export function otaFirmwareRoute(
  before: string,
  target: string,
  patches: {start_firmware: string; end_firmware: string}[] = [],
): string[] {
  let current = normalizeFirmware(before)
  const destination = normalizeFirmware(target)
  const route = new Set([current])
  while (current !== destination) {
    const patch = patches.find((entry) => normalizeFirmware(entry.start_firmware) === current)
    if (!patch) break // The pinned full image remains the final fallback.
    current = normalizeFirmware(patch.end_firmware)
    if (route.has(current)) throw new Error("Cyclic pinned firmware route")
    route.add(current)
  }
  route.add(destination)
  return [...route]
}

/** A stock ASG build can briefly reappear during the owned uninstall/reinstall detour. */
export function checkOtaObservedVersions(
  firmware: string,
  asgVersion: number,
  allowedFirmware: string[],
  asgVersions: number[],
  observingActivePass: boolean,
) {
  checkOtaObservedFirmware(firmware, allowedFirmware)
  if (!asgVersions.includes(asgVersion) && !observingActivePass) throw new OtaValidationError("UNEXPECTED_ASG_VERSION")
}

export function checkOtaObservedFirmware(firmware: string, allowedFirmware: string[]) {
  const normalized = normalizeFirmware(firmware)
  if (!allowedFirmware.map(normalizeFirmware).includes(normalized)) throw new OtaValidationError("UNEXPECTED_FIRMWARE")
  return normalized
}

export type OtaPage =
  | "available"
  | "offered"
  | "checking"
  | "working"
  | "pass-complete"
  | "complete"
  | "current"
  | "failed"
  | "home"
  | "unknown"

/** A Done button alone also appears on errors; require the actual page message. */
export function otaPage(state: Snapshot): {kind: OtaPage; title: string; finishControl?: string} {
  const labels = state.elements.filter((e) => e.visible).map((e) => e.description || e.value || e.title)
  const has = (text: string) => labels.includes(text)
  const error = [
    "Update Failed",
    "Check Failed",
    "Updates Blocked",
    "Development Build",
    "Update Info Unavailable",
    "WiFi Needed for Update",
  ].find(has)
  if (error) return {kind: "failed", title: error}
  if (has("Your glasses are running the latest version.") && (has("Update Complete") || has("Update complete")))
    return {kind: "complete", title: has("Update Complete") ? "Update Complete" : "Update complete"}
  if (has("Your glasses are running the latest version.") && (has("Up to Date") || has("Up To Date")))
    return {kind: "current", title: has("Up to Date") ? "Up to Date" : "Up To Date"}
  if (has("Checking for updates") || has("Checking for updates..."))
    return {kind: "checking", title: "Checking for updates"}
  // These finish an installation pass and return to the additional-update check.
  // They cannot qualify the target set by themselves.
  for (const [title, message, button] of [
    ["Update complete!", "Your glasses are up to date.", "Done"],
    [
      "Firmware updated",
      "Your glasses restarted with new firmware. One more step: they'll now continue to the required version.",
      "Continue",
    ],
    [
      "Version Change Complete",
      "Your glasses are now on the required version. Their settings were reset and are being restored automatically.",
      "Done",
    ],
  ]) {
    if (has(title) && has(message) && has(button))
      return {kind: "pass-complete", title, finishControl: `button-${button}`}
  }
  if (state.elements.some((e) => e.visible && e.identifier === "button-Update Now"))
    return {kind: "available", title: "Mentra Live Update Available"}
  if (has("Mentra Live Update Available") && has("Install"))
    return {kind: "offered", title: "Mentra Live Update Available"}
  const progress = [
    "Starting update...",
    "Downloading update to phone...",
    "Starting glasses hotspot...",
    "Connecting phone to glasses...",
    "Transferring update to glasses...",
    "Installing update on glasses...",
    "Downloading...",
    "Installing...",
    "Installing a different version…",
    "Verifying your glasses…",
    "Finishing your update",
    "Restarting Mentra Live…",
    "Please wait while Mentra Live restarts and automatically reconnects...",
  ].find(has)
  if (progress) return {kind: "working", title: progress}
  if (has("Glasses disconnected") && has("Reconnecting...")) return {kind: "working", title: "Glasses disconnected"}
  if (state.elements.some((e) => e.visible && e.identifier === "home.miniapp.com.mentra.settings") && !has("Done"))
    return {kind: "home", title: "Paired home"}
  return {kind: "unknown", title: labels.filter(Boolean).slice(0, 4).join(" / ")}
}

export function selectUsbTransport(inventory: string, serial: string, usb: string): string {
  const rows = inventory
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] === serial)
  if (rows.length === 0) throw new OtaHardwareUnavailable("transport", "Expected USB fixture is absent")
  if (rows.length !== 1) throw new OtaValidationError("Expected USB fixture is ambiguous")
  const parts = rows[0]
  if (parts.some((part) => part.startsWith("usb:") && part !== `usb:${usb}`))
    throw new OtaValidationError("USB fixture path mismatch")
  if (parts[1] === "offline") throw new OtaHardwareUnavailable("transport", "Expected USB fixture is offline")
  if (parts[1] !== "device" || !parts.includes(`usb:${usb}`))
    throw new OtaValidationError("USB fixture is unauthorized or has no verified USB path")
  const transport = /\btransport_id:(\d+)\b/.exec(parts.join(" "))?.[1]
  if (!transport) throw new OtaValidationError("USB fixture has no transport id")
  return transport
}

/** An explicitly selected network endpoint is only a transport; callers must verify device identity. */
export function selectWifiTransport(inventory: string, endpoint: string): string {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(endpoint)
  if (
    !match ||
    match[1].split(".").some((part) => Number(part) > 255) ||
    Number(match[2]) < 1 ||
    Number(match[2]) > 65535
  )
    throw new OtaValidationError("Expected an explicit IPv4 ADB endpoint with port")
  const rows = inventory
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] === endpoint)
  if (rows.length === 0) throw new OtaHardwareUnavailable("transport", "Expected Wi-Fi fixture is absent")
  if (rows.length !== 1) throw new OtaValidationError("Expected Wi-Fi fixture is ambiguous")
  const parts = rows[0]
  if (parts[1] === "offline") throw new OtaHardwareUnavailable("transport", "Expected Wi-Fi fixture is offline")
  if (parts[1] !== "device" || parts.some((part) => part.startsWith("usb:")))
    throw new OtaValidationError("Wi-Fi fixture is unauthorized or has an unexpected USB path")
  const transport = /\btransport_id:(\d+)\b/.exec(parts.join(" "))?.[1]
  if (!transport) throw new OtaValidationError("Wi-Fi fixture has no transport id")
  return transport
}

export function freshBesProof(log: string, bootId: string, deviceEpoch: number): {version: string; ageSeconds: number} {
  const proofs = [...log.matchAll(/^\s*(\d+\.\d+)[^\n]*BES_OTA_DIAG version_proof actual=(\S+) current_boot=(\S+)/gm)]
  const proof = proofs.filter((p) => p[3] === bootId).at(-1)
  const ageSeconds = proof ? deviceEpoch - Number(proof[1]) : Infinity
  if (
    !proof ||
    !Number.isFinite(ageSeconds) ||
    ageSeconds < -2 ||
    ageSeconds > 30 ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(proof[2])
  )
    throw new Error("No fresh BES version response tied to the current glasses boot")
  return {version: proof[2], ageSeconds}
}
