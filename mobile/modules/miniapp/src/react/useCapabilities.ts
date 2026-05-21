/**
 * @fileoverview useCapabilities — React hook that returns the currently
 * connected glasses' capability profile (or null when no glasses are paired)
 * and re-renders when capabilities change.
 *
 * Seeded from session.capabilities synchronously; re-subscribes on CONNECT_ACK
 * ("ready") and on CAPABILITIES_UPDATE pushes so consumers don't need to wire
 * event handlers themselves.
 */

import {useEffect, useState} from "react"

import {type GlassesCapabilities} from "../session"
import {useSession} from "./useSession"

export function useCapabilities(): GlassesCapabilities | null {
  const session = useSession()
  const [caps, setCaps] = useState<GlassesCapabilities | null>(session.capabilities)

  useEffect(() => {
    setCaps(session.capabilities)
    const offReady = session.on("ready", () => setCaps(session.capabilities))
    const offCaps = session.onCapabilitiesChange(setCaps)
    return () => {
      offReady()
      offCaps()
    }
  }, [session])

  return caps
}
