/**
 * @fileoverview useSession — zero-config React hook that returns a MiniappSession.
 *
 * Shared singleton across the entire miniapp. Calls connect() once; calling
 * useSession multiple times in different components returns the same session.
 */

import {useState} from "react"

import {MiniappSession} from "../session"

let sharedSession: MiniappSession | null = null

export function useSession(): MiniappSession {
  const [session] = useState<MiniappSession>(() => {
    if (!sharedSession) {
      sharedSession = new MiniappSession()
      // Fire-and-forget. Callers that care about readiness can observe
      // session.ready / session.waitForReady(). Queue-before-ACK behavior
      // in MiniappSession ensures no calls are lost if the UI invokes
      // session.display.showTextWall(...) during the initial render.
      sharedSession.connect().catch((err) => {
        console.error("[@mentra/miniapp] connect failed:", err)
      })
    }
    return sharedSession
  })
  return session
}

/** @internal — for tests. Clears the shared session without disconnecting. */
export function __resetSharedSession(): void {
  sharedSession = null
}
