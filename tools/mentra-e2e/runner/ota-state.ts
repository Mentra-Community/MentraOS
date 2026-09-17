import type {Snapshot} from "./driver"

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
  const rows = inventory.split("\n").filter((line) => {
    const parts = line.trim().split(/\s+/)
    return parts[0] === serial && parts[1] === "device" && parts.includes(`usb:${usb}`)
  })
  if (rows.length !== 1) throw new Error("Expected USB fixture is absent or ambiguous")
  const transport = /\btransport_id:(\d+)\b/.exec(rows[0])?.[1]
  if (!transport) throw new Error("USB fixture has no transport id")
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
