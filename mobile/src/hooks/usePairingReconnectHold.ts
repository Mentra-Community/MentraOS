import {useEffect, useState} from "react"

/**
 * When a pairing window ends, the SDK reconnects, but the pairing state drops to
 * normal a moment before it publishes CONNECTING, which flashes "Connect glasses".
 * Hold the reconnecting spinner across that gap. During the window itself there's
 * no hold: nothing connects by itself.
 */
export const PAIRING_RECONNECT_HOLD_MS = 3000

export function usePairingReconnectHold(input: {
  inPairingMode: boolean
  connected: boolean
  rejected: boolean
  linkBusy: boolean
}): boolean {
  const {inPairingMode, connected, rejected, linkBusy} = input
  const [hold, setHold] = useState(false)

  useEffect(() => {
    if (inPairingMode) {
      setHold(true)
      return
    }
    if (!hold) return
    if (connected || rejected || linkBusy) {
      setHold(false)
      return
    }
    const timer = setTimeout(() => setHold(false), PAIRING_RECONNECT_HOLD_MS)
    return () => clearTimeout(timer)
  }, [inPairingMode, hold, connected, rejected, linkBusy])

  return hold && !inPairingMode
}
