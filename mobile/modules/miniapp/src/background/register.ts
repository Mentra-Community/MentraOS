/**
 * registerMiniapp — entry hook for the background JSContext.
 *
 * The MentraJS host loads the polyfill (which installs __dispatch /
 * __deliver / timers / fetch / etc.), then evaluates the miniapp's
 * background bundle. After both scripts have evaluated successfully,
 * the host delivers a single `{kind: "init", sessionId}` envelope.
 * The polyfill turns that into a call to `__mentraInitCallback(sessionId)`.
 *
 * This module wires that callback to:
 *   1. Construct a `MiniappSession` (DispatchTransport picks itself
 *      automatically because `__dispatch` is on globalThis).
 *   2. Call the user-supplied handler synchronously so subscriptions
 *      are registered before any host events fan out.
 *   3. Call `session.connect()` so the host receives CONNECT and the
 *      first CONNECT_ACK populates `userId`, `capabilities`, etc.
 *
 * The handler runs once per spawn. If the host kills + respawns the
 * JSContext (crash recovery, dev reload), the polyfill + bundle are
 * re-evaluated and the handler fires again with a fresh session.
 */

import {MiniappSession, type MiniappSessionOptions} from "../session"

export type TypedMiniappSession<TChannels extends object> = MiniappSession<TChannels>

export type MiniappInitHandler<TChannels extends object = Record<string, unknown>> = (
  session: TypedMiniappSession<TChannels>,
) => void | Promise<void>

interface InitGlobals {
  __mentraInitCallback?: (sessionId: string) => void
  /**
   * Polyfill-injected host bridge for surfacing structured errors to the
   * host's MentraJSRouter (which feeds them into MentraJSCrashController).
   * Optional because tests / pure-Node environments don't have it.
   */
  __hostError?: (payloadJson: string) => void
}

/**
 * Register the miniapp's startup handler. Call once at the top level of
 * `src/background/index.ts`. Top-level side effects are fine, but the
 * vast majority of setup should live inside the handler so it can run
 * with a connected session.
 *
 * @example
 *   registerMiniapp((session) => {
 *     session.transcription.on((tx) => {
 *       session.display.render([{type: "text", id: "tx", box, text: tx.text}])
 *     })
 *   })
 */
export function registerMiniapp<TChannels extends object = Record<string, unknown>>(
  handler: MiniappInitHandler<TChannels>,
  options: MiniappSessionOptions = {},
): void {
  const g = globalThis as unknown as InitGlobals
  g.__mentraInitCallback = (_sessionId: string) => {
    const session = new MiniappSession<TChannels>(options)
    // Fire the user handler first so any session.* subscriptions get
    // registered before the CONNECT_ACK fan-out lands.
    try {
      const result = handler(session)
      if (result && typeof (result as Promise<void>).then === "function") {
        ;(result as Promise<void>).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[mentra-miniapp] registerMiniapp handler rejected:", err)
        })
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[mentra-miniapp] registerMiniapp handler threw:", err)
    }
    session.connect().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[mentra-miniapp] session.connect() rejected:", err)
      // Surface to the host's crash controller as a structured uncaught
      // error so the existing backoff + crashloop machinery handles it.
      // Repeated connect failures eventually flip the miniapp to
      // CRASHLOOP_DISABLED, which the host turns into a user-facing
      // alert + automatic incident report.
      try {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error && err.stack ? err.stack : ""
        g.__hostError?.(JSON.stringify({message: `session.connect() failed: ${message}`, stack}))
      } catch {
        /* host bridge missing in tests — ignore */
      }
    })
  }
}
