/**
 * @fileoverview useConnected — React hook that returns true while the miniapp
 * session is connected to the host (after CONNECT_ACK) and flips to false on
 * disconnect.
 */

import {useEffect, useState} from "react"

import {useSession} from "./useSession"

export function useConnected(): boolean {
  const session = useSession()
  const [connected, setConnected] = useState<boolean>(session.ready)

  useEffect(() => {
    setConnected(session.ready)
    const offReady = session.on("ready", () => setConnected(true))
    const offDisc = session.on("disconnect", () => setConnected(false))
    return () => {
      offReady()
      offDisc()
    }
  }, [session])

  return connected
}
