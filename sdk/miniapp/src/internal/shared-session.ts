/**
 * @fileoverview Shared MiniappSession singleton for the whole webview.
 *
 * Both `useSession()` (React hook, library shape) and the framework
 * primitives (`session` import from "@mentra/miniapp/framework") read
 * from this same singleton, so a miniapp that mixes the two does not
 * end up with two `MiniappSession` instances racing.
 */

import {MiniappSession} from "../session"

let sharedSession: MiniappSession | null = null

/**
 * Get or create the process-wide shared MiniappSession. Calls
 * `connect()` once; subsequent calls return the same instance.
 */
export function getOrCreateSharedSession(): MiniappSession {
  if (!sharedSession) {
    sharedSession = new MiniappSession()
    sharedSession.connect().catch((err) => {
      console.error("[@mentra/miniapp] connect failed:", err)
    })
  }
  return sharedSession
}

/**
 * @internal — for tests. Clears the shared session without disconnecting.
 */
export function __resetSharedSession(): void {
  sharedSession = null
}
