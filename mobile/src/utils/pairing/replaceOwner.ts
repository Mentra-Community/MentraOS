/**
 * Pure helpers for the ownership-transfer confirm step. Kept free of React
 * Native imports so the routing and result rules are unit-testable on their own.
 */

export const REPLACE_OWNER_ROUTE = "/pairing/replace-owner"

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
}

/**
 * Route on `awaiting_confirm` only. `had_previous_bond` says an owner existed,
 * not that the glasses are waiting for the user, so it never drives this.
 */
export const shouldRouteToReplaceOwner = ({
  platformSupported,
  awaitingConfirm,
  securePairing,
}: ShouldRouteToReplaceOwnerInput): boolean => platformSupported && securePairing && awaitingConfirm === true

export type ReplaceOwnerError = "not_pairing" | "wipe_failed" | "failed" | "timeout"

export type ReplaceOwnerResultAction = {kind: "continue"} | {kind: "error"; error: ReplaceOwnerError}

/**
 * Maps `confirm_replace_owner_result` to what the screen does next.
 * `no_owner` means there was nothing left to replace, so the flow continues
 * exactly like success. Unknown refusal reasons surface as a generic failure.
 */
export const classifyReplaceOwnerResult = (event: {ok: boolean; reason?: string}): ReplaceOwnerResultAction => {
  if (event.ok) return {kind: "continue"}
  switch (event.reason) {
    case "no_owner":
      return {kind: "continue"}
    case "not_pairing":
      return {kind: "error", error: "not_pairing"}
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
