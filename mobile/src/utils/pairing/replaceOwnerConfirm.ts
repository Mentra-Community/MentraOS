import BluetoothSdk, {type ConfirmReplaceOwnerResultEvent} from "@mentra/bluetooth-sdk"
import {engine} from "@mentra/engine"

import {useNavigationStore} from "@/stores/navigation"
import {
  classifyReplaceOwnerResult,
  REPLACE_OWNER_CONFIRM_TIMEOUT_MS,
  REPLACE_OWNER_ROUTE,
  RETAINED_OWNER_PAIRING_ERROR,
  type ReplaceOwnerError,
} from "@/utils/pairing/replaceOwner"

/**
 * Owns one `confirm_replace_owner` round trip, independent of any screen.
 *
 * The replace-owner screen pops back to the pairing loading screen the moment the user
 * taps Replace owner. The glasses ask iOS to pair right after they accept the confirm, so
 * the system prompt must find the loading screen on top, not the confirm screen. The
 * result therefore cannot be handled by the screen that sent it. This controller keeps
 * the timeout and the result listener alive across that pop and brings the confirm
 * screen back, with the reason, only if the confirm fails.
 */

export type ReplaceOwnerConfirmState = {
  phase: "idle" | "busy" | "error"
  error: ReplaceOwnerError | null
}

type Listener = (state: ReplaceOwnerConfirmState) => void

const LOADING_ROUTE = "/pairing/loading"
const IDLE: ReplaceOwnerConfirmState = {phase: "idle", error: null}

let state: ReplaceOwnerConfirmState = IDLE
let timeout: ReturnType<typeof setTimeout> | null = null
let resultSub: {remove: () => void} | null = null
let onContinue: (() => void) | null = null
let target: {deviceModel?: string; deviceName?: string} = {}
const listeners = new Set<Listener>()

const setState = (next: ReplaceOwnerConfirmState) => {
  state = next
  listeners.forEach((listener) => listener(state))
}

const clearTimer = () => {
  if (timeout) {
    clearTimeout(timeout)
    timeout = null
  }
}

const stopListening = () => {
  resultSub?.remove()
  resultSub = null
}

/** Show the confirm screen again, with the reason, if it is not already the visible one. */
const surfaceError = (error: ReplaceOwnerError) => {
  clearTimer()
  const nav = useNavigationStore.getState()
  const route = nav.getCurrentRoute()
  // The user already left for the failure screen (or anywhere else): nothing to retry.
  if (route !== REPLACE_OWNER_ROUTE && route !== LOADING_ROUTE) {
    resetReplaceOwnerConfirm()
    return
  }
  setState({phase: "error", error})
  if (route !== REPLACE_OWNER_ROUTE) nav.push(REPLACE_OWNER_ROUTE, target)
}

const handleResult = (event: ConfirmReplaceOwnerResultEvent) => {
  console.log(`PAIRFLOW: replace_owner_result ok=${event.ok} reason=${event.reason ?? ""}`)
  const action = classifyReplaceOwnerResult(event)
  if (action.kind === "continue") {
    const proceed = onContinue
    resetReplaceOwnerConfirm()
    proceed?.()
    return
  }
  if (action.kind === "yield") {
    // This phone is the retained owner. Native yields; abandoning would destroy that
    // yield and reconnect over the phone that should confirm.
    resetReplaceOwnerConfirm()
    console.log("PAIRFLOW: replace_owner_yield_retained_owner")
    useNavigationStore.getState().replace("/pairing/failure", {
      error: RETAINED_OWNER_PAIRING_ERROR,
      deviceModel: target.deviceModel,
    })
    return
  }
  surfaceError(action.error)
}

export const getReplaceOwnerConfirmState = (): ReplaceOwnerConfirmState => state

export const subscribeReplaceOwnerConfirm = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * What the visible confirm screen does when the confirm succeeds (pop to the loading
 * screen). A screen registers on mount and clears on unmount, so a result that arrives
 * after it popped changes nothing: the loading screen underneath just carries on.
 */
export const setReplaceOwnerContinue = (proceed: (() => void) | null): void => {
  onContinue = proceed
}

/** Sends the confirm and keeps handling its result whichever screen is showing. */
export const startReplaceOwnerConfirm = (params: {deviceModel?: string; deviceName?: string}): void => {
  if (state.phase === "busy") return
  console.log("PAIRFLOW: replace_owner_confirm")
  target = params
  clearTimer()
  stopListening()
  setState({phase: "busy", error: null})
  resultSub = BluetoothSdk.addListener("confirm_replace_owner_result", handleResult)
  timeout = setTimeout(() => {
    timeout = null
    // The listener stays: a late success still continues.
    if (state.phase === "busy") surfaceError("timeout")
  }, REPLACE_OWNER_CONFIRM_TIMEOUT_MS)
  engine.pairing.confirmReplaceOwner().catch((confirmError: unknown) => {
    console.warn("confirmReplaceOwner failed:", confirmError)
    if (state.phase === "busy") surfaceError("failed")
  })
}

/** Drops any pending confirm: cancel, failure, or a finished round trip. */
export function resetReplaceOwnerConfirm(): void {
  clearTimer()
  stopListening()
  onContinue = null
  if (state !== IDLE) setState(IDLE)
}
