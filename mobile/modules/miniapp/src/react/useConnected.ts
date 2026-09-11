/**
 * @fileoverview useConnected — React hook that returns true while the miniapp's
 * UI WebView is bridged to its background JSContext.
 *
 * WebView-side hook. "Connected" here means the `window.mentra` bridge is open:
 * the shim has fired `mentra.ready()` and the host has bound the WebView so
 * `mentra.send/on/request` flow. Tracked via the shim's `onOpen` / `onClose`.
 * `onOpen` fires its callback immediately if the bridge is already open (see
 * the shim), so late mounts still observe the connected state.
 *
 * IMPORTANT: this hook must NOT construct a `MiniappSession`. That is the
 * *background* (JSContext) API; inside a UI WebView its `CONNECT` never gets an
 * ACK from the host's UI router and `session.connect()` times out
 * ("CONNECT_ACK timeout").
 */

import {useEffect, useState} from "react"

interface MentraBridge {
  onOpen?: (cb: () => void) => () => void
  onClose?: (cb: () => void) => () => void
}

function getBridge(): MentraBridge | null {
  if (typeof window === "undefined") return null
  return (window as unknown as {mentra?: MentraBridge}).mentra ?? null
}

export function useConnected(): boolean {
  const [connected, setConnected] = useState<boolean>(false)

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge) return

    // onOpen fires immediately when the bridge is already open, so this also
    // seeds the initial value without a separate synchronous read.
    const offOpen = bridge.onOpen?.(() => setConnected(true))
    const offClose = bridge.onClose?.(() => setConnected(false))
    return () => {
      offOpen?.()
      offClose?.()
    }
  }, [])

  return connected
}
