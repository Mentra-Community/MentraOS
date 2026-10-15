/**
 * Pure helpers for the ownership-transfer confirm step. Kept free of React
 * Native imports so the routing and result rules are unit-testable on their own.
 */

export const REPLACE_OWNER_ROUTE = "/pairing/replace-owner"
export const BT_CLASSIC_ROUTE = "/pairing/btclassic"

/** Shown when this phone is the retained owner and must leave the BLE slot. */
export const RETAINED_OWNER_PAIRING_ERROR = "errors:pairingAlreadyOwner"

/**
 * iOS derives the Classic bond from the BLE pair. The connecting screen waits
 * this long for that bond before it asks the user to open Settings.
 */
export const IOS_CLASSIC_SETTLE_MS = 30_000

/**
 * iOS has no API to start Classic audio pairing. The Mentra App does BLE first
 * and opens Settings only if Classic is still down after the settle window.
 * Android gets Classic from the BLE bond and skips this step.
 */
export const shouldPairClassicAfterBle = ({
  platform,
  deviceModel,
  bluetoothClassicConnected,
}: {
  platform: string
  deviceModel: string
  bluetoothClassicConnected: boolean
}): boolean => platform === "ios" && deviceModel === "Mentra Live" && !bluetoothClassicConnected

/**
 * `done`: nothing to wait for (not iOS Mentra Live, or Classic is already up).
 * `waiting`: iOS Mentra Live, Classic still coming up inside the settle window.
 * `fallback`: the settle window passed with no Classic signal, so ask the user to tap the glasses in Settings.
 */
export type ClassicWaitState = "done" | "waiting" | "fallback"

/**
 * Any of the three Classic readiness signals ends the wait: the bond, the connected
 * profiles, or the audio route. Only iOS Mentra Live waits; Android attaches Classic
 * from the BLE bond.
 */
export const classicWaitState = ({
  platform,
  deviceModel,
  bluetoothClassicConnected,
  bluetoothClassicProfilesConnected,
  bluetoothAudioRouted,
  settleElapsed,
}: {
  platform: string
  deviceModel: string
  bluetoothClassicConnected: boolean
  bluetoothClassicProfilesConnected: boolean
  bluetoothAudioRouted: boolean
  settleElapsed: boolean
}): ClassicWaitState => {
  if (platform !== "ios" || deviceModel !== "Mentra Live") return "done"
  if (bluetoothClassicConnected || bluetoothClassicProfilesConnected || bluetoothAudioRouted) return "done"
  return settleElapsed ? "fallback" : "waiting"
}

/** The glasses answer `confirm_replace_owner` within this budget or the app offers retry/cancel. */
export const REPLACE_OWNER_CONFIRM_TIMEOUT_MS = 10_000

/** How long the link may stay down before the confirm screen gives up on the window. */
export const REPLACE_OWNER_LINK_LOST_GRACE_MS = 3_000

export type ShouldRouteToReplaceOwnerInput = {
  /** `isMentraLiveOwnershipTransferSupported()`: the flag and the platform gate. */
  platformSupported: boolean
  /** `pairing_info.awaiting_confirm`; absent counts as false. */
  awaitingConfirm: boolean | undefined
  /** The target is a Mentra Live pairing under the secure pairing flow. */
  securePairing: boolean
  /** `pairing_info.retained_owner_link`; this phone is the owner the glasses kept. */
  retainedOwnerLink?: boolean
}

/**
 * Route on `awaiting_confirm` only, and never for the phone that already owns
 * the glasses. `had_previous_bond` says an owner existed, not that the glasses
 * are waiting for this phone, so it never drives this.
 */
export const shouldRouteToReplaceOwner = ({
  platformSupported,
  awaitingConfirm,
  securePairing,
  retainedOwnerLink,
}: ShouldRouteToReplaceOwnerInput): boolean =>
  platformSupported && securePairing && awaitingConfirm === true && retainedOwnerLink !== true

export type ReplaceOwnerError = "not_pairing" | "wipe_failed" | "failed" | "timeout"

export type ReplaceOwnerResultAction =
  | {kind: "continue"}
  | {kind: "error"; error: ReplaceOwnerError}
  | {kind: "yield"}

/**
 * Maps `confirm_replace_owner_result` to what the screen does next.
 * `no_owner` means there was nothing left to replace, so the flow continues
 * exactly like success. `retained_owner` means this phone is the owner the
 * glasses kept, so it leaves the slot instead of retrying. Unknown refusal
 * reasons surface as a generic failure.
 */
export const classifyReplaceOwnerResult = (event: {ok: boolean; reason?: string}): ReplaceOwnerResultAction => {
  if (event.ok) return {kind: "continue"}
  switch (event.reason) {
    case "no_owner":
      return {kind: "continue"}
    case "not_pairing":
      return {kind: "error", error: "not_pairing"}
    case "retained_owner":
      return {kind: "yield"}
    case "wipe_failed":
      return {kind: "error", error: "wipe_failed"}
    default:
      return {kind: "error", error: "failed"}
  }
}

/** Translation key for the message shown under each error. */
export const REPLACE_OWNER_ERROR_TX = {
  not_pairing: "pairing:replaceOwnerNotPairing",
  wipe_failed: "pairing:replaceOwnerWipeFailed",
  failed: "pairing:replaceOwnerFailed",
  timeout: "pairing:replaceOwnerTimeout",
} as const satisfies Record<ReplaceOwnerError, string>
