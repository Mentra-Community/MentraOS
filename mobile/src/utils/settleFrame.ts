import {InteractionManager} from "react-native"

/** Give up waiting rather than hang a caller forever if a frame never lands. */
const SETTLE_TIMEOUT_MS = 500

/**
 * Wait until React has actually committed pending work to the screen.
 *
 * `await`ing a promise is not enough when the thing you are waiting on is a
 * mount commit rather than a promise, and `InteractionManager
 * .runAfterInteractions` alone is not enough either: it resolves immediately
 * when the interaction queue happens to be empty, which it usually is at the
 * moment you ask. That returns in single-digit milliseconds and the caller
 * proceeds as if the UI had updated when it has not.
 *
 * Draining the interaction queue and then waiting two animation frames does
 * hold until a frame has been rendered — the first frame schedules the commit,
 * the second runs after it. The timeout is a guard so a caller can never be
 * wedged by a frame that never arrives (a backgrounded app, for instance).
 *
 * Use this before destroying something the current screen is rendered inside
 * of. See LogoutUtils and the Profile sign-out path (OS-1834).
 */
export function settleFrame(): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const guard = setTimeout(finish, SETTLE_TIMEOUT_MS)

    InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(guard)
          finish()
        }),
      )
    })
  })
}
