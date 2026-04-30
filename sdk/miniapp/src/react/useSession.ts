/**
 * @fileoverview useSession — zero-config React hook that returns a MiniappSession.
 *
 * Shared singleton across the entire miniapp. Calls connect() once; calling
 * useSession multiple times in different components returns the same session.
 */

import {useState} from "react"

import {getOrCreateSharedSession, __resetSharedSession as _reset} from "../internal/shared-session"
import type {MiniappSession} from "../session"

export function useSession(): MiniappSession {
  const [session] = useState<MiniappSession>(() => getOrCreateSharedSession())
  return session
}

/** @internal — for tests. Clears the shared session without disconnecting. */
export function __resetSharedSession(): void {
  _reset()
}
