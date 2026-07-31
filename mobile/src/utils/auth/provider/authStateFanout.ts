import {MentraAuthSession} from "@/utils/auth/authProvider.types"

export type AuthStateListener = (event: string, session: MentraAuthSession) => void

export interface AuthStateFanout {
  subscribe(listener: AuthStateListener): {unsubscribe: () => void}
  emit(event: string, session: MentraAuthSession): void
  /** Live listener count. Exists so tests can assert unsubscribe really removed one. */
  readonly size: number
}

/**
 * Delivers auth-state events to every consumer, not just the most recent one.
 *
 * The provider used to keep a single callback slot that each onAuthStateChange()
 * overwrote. Two consumers subscribe in practice — AuthContext, which drives
 * navigation off the login screen, and the engine's cloud client via
 * MantleManager — so whichever registered last silently stole the events from
 * the other, and either one's unsubscribe() nulled the slot for both.
 *
 * The engine registers second (index.tsx awaits mantle.init() after AuthContext
 * has mounted), so from that point the UI stopped hearing anything. A second
 * Google SSO sign-in in the same process saved its tokens and then left the user
 * on the login screen, and only force-quitting helped, because a cold start
 * reads the persisted session directly rather than waiting for an event. That is
 * the "SSO bounces me back to login until I reopen the app" report (OS-1828).
 *
 * The v1 authing provider used an EventEmitter and never had this problem; the
 * single slot arrived with the Cloud V2 cutover.
 *
 * This lives in its own module so the behaviour can be tested directly. Asserting
 * it through AccountAuthProvider would mean booting that provider's storage,
 * fetch and endpoint-resolution dependencies, and a test that reimplements the
 * fanout instead would keep passing if this file regressed to a single slot.
 */
export function createAuthStateFanout(): AuthStateFanout {
  const listeners = new Set<AuthStateListener>()

  return {
    subscribe(listener: AuthStateListener) {
      listeners.add(listener)
      // Removes only this listener. The old slot-clearing unsubscribe took every
      // other consumer down with it.
      return {unsubscribe: () => void listeners.delete(listener)}
    },

    emit(event: string, session: MentraAuthSession) {
      // Snapshot first: a listener may unsubscribe (or subscribe) from inside its
      // own callback, which would otherwise mutate the set mid-iteration and can
      // skip a later listener.
      for (const listener of [...listeners]) {
        try {
          listener(event, session)
        } catch (error) {
          // One consumer throwing must not stop the rest from learning about the
          // sign-in — that is the failure this whole structure exists to prevent.
          console.warn("AccountAuthProvider: auth state listener threw", error)
        }
      }
    },

    get size() {
      return listeners.size
    },
  }
}
