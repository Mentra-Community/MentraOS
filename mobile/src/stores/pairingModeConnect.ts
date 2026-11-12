import {engine} from "@mentra/engine"
import {useEffect} from "react"
import {create} from "zustand"

/**
 * The person's own Connect glasses press during a pairing window.
 *
 * In pairing mode the SDK connects nothing by itself, so Home and Settings offer Connect glasses
 * and ignore the link state. Once the person presses it, the attempt is theirs and must show as
 * connecting until it ends: without this the button came back half a second into the attempt,
 * while the link was still connecting, and the spinner returned when the glasses closed their
 * window. Shared by both screens, so the one that didn't take the press shows the same attempt.
 */
interface PairingModeConnectState {
  /** The window Connect glasses was pressed in, until Cancel or the window is left. */
  windowId: number | null
  /** The connect call hasn't returned from the SDK yet, so no link state can show it. */
  starting: boolean
}

const idle: PairingModeConnectState = {windowId: null, starting: false}

export const usePairingModeConnectStore = create<PairingModeConnectState>(() => idle)

/** Connect the saved glasses from their pairing window, as the person's choice. */
export async function connectInPairingMode(windowId: number): Promise<void> {
  usePairingModeConnectStore.setState({windowId, starting: true})
  try {
    await engine.glasses.connectInPairingMode()
  } catch (error) {
    cancelPairingModeConnect()
    throw error
  }
  // A Cancel or a new window while the call was in flight already replaced this attempt.
  if (usePairingModeConnectStore.getState().windowId === windowId) {
    usePairingModeConnectStore.setState({starting: false})
  }
}

/** Cancel pressed: the attempt is over, and the window offers Connect glasses again. */
export function cancelPairingModeConnect(): void {
  if (usePairingModeConnectStore.getState() !== idle) usePairingModeConnectStore.setState(idle, true)
}

/**
 * Whether the person asked to connect in this pairing window (`requested`), and whether that
 * call is still on its way to the SDK (`starting`). Pass `undefined` outside pairing mode.
 */
export function usePairingModeConnect(windowId: number | undefined): {requested: boolean; starting: boolean} {
  const state = usePairingModeConnectStore()
  // Window ids repeat (older firmware sends none), so an attempt never outlives its window.
  useEffect(() => {
    if (windowId === undefined) cancelPairingModeConnect()
  }, [windowId])
  const requested = windowId !== undefined && state.windowId === windowId
  return {requested, starting: requested && state.starting}
}
