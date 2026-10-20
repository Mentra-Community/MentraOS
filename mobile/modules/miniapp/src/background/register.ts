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
 *      first CONNECT_ACK populates `userId`, `capabilities`, etc. A host that
 *      has not answered within `connectTimeoutMs` gets CONNECT again; that is
 *      a stalled host, not a miniapp crash.
 *   4. Send READY once the handler's returned promise settles. Hosts that
 *      advertise `hostFeatures.initReady` keep the UI closed until then.
 *
 * The handler runs once per spawn. If the host kills + respawns the
 * JSContext (crash recovery, dev reload), the polyfill + bundle are
 * re-evaluated and the handler fires again with a fresh session.
 */

import {ConnectAckTimeoutError, MiniappSession, NotConnectedError, type MiniappSessionOptions} from "../session"

/** Pause before CONNECT is sent again after a CONNECT_ACK timeout. */
const CONNECT_RETRY_MS = 1_000

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
  /**
   * The session from the latest init. Global rather than module state so a
   * bundle evaluated again in the same context also finds it.
   */
  __mentraBackgroundSession?: BackgroundSession
}

interface BackgroundSession {
  session: MiniappSession
  retryTimer: ReturnType<typeof setTimeout> | null
}

/** A later init replaces the session: stop its handshake so it neither retries nor reports. */
function releaseBackgroundSession(g: InitGlobals): void {
  const previous = g.__mentraBackgroundSession
  if (!previous) return
  g.__mentraBackgroundSession = undefined
  if (previous.retryTimer) clearTimeout(previous.retryTimer)
  previous.retryTimer = null
  previous.session.disconnect()
}

/**
 * Resolves once a CONNECT is acknowledged. A CONNECT_ACK timeout sends CONNECT
 * again for as long as this is the current session; any other failure rejects.
 */
function connectUntilAcknowledged(g: InitGlobals, current: BackgroundSession): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const attempt = () => {
      current.retryTimer = null
      current.session.connect().then(resolve, (err: unknown) => {
        if (g.__mentraBackgroundSession === current && err instanceof ConnectAckTimeoutError) {
          // eslint-disable-next-line no-console
          console.warn("[mentra-miniapp] CONNECT_ACK timed out; sending CONNECT again")
          current.retryTimer = setTimeout(attempt, CONNECT_RETRY_MS)
          return
        }
        reject(err)
      })
    }
    attempt()
  })
}

/**
 * Register the miniapp's startup handler. Call once at the top level of
 * `src/background/index.ts`. Top-level side effects are fine, but the
 * vast majority of setup should live inside the handler so it can run
 * with a connected session.
 *
 * Return the handler's startup promise (don't `void` it): the Mentra App
 * shows its splash and holds UI requests until it settles, so register
 * `session.ui.handle` handlers before any slow await.
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
  releaseBackgroundSession(g)
  g.__mentraInitCallback = (sessionId: string) => {
    releaseBackgroundSession(g)
    const session = new MiniappSession<TChannels>(options)
    const current: BackgroundSession = {session, retryTimer: null}
    g.__mentraBackgroundSession = current
    // The handler's returned promise defines readiness: the host keeps the UI
    // closed until it settles, so handlers registered after an await still
    // exist before the first UI request arrives.
    session.announceInitReady(sessionId)
    let initSettled: Promise<void> = Promise.resolve()
    // Fire the user handler first so any session.* subscriptions get
    // registered before the CONNECT_ACK fan-out lands.
    try {
      const result = handler(session)
      if (result && typeof (result as Promise<void>).then === "function") {
        initSettled = (result as Promise<void>).then(
          () => undefined,
          (err: unknown) => {
            // eslint-disable-next-line no-console
            console.error("[mentra-miniapp] registerMiniapp handler rejected:", err)
          },
        )
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[mentra-miniapp] registerMiniapp handler threw:", err)
    }
    const connected = connectUntilAcknowledged(g, current)
    // A failed handler still reports READY: its UI must not stay closed.
    void Promise.all([connected, initSettled]).then(
      () => session.reportInitReady(),
      () => {
        /* connect failure is reported below */
      },
    )
    connected.catch((err: unknown) => {
      // Replaced by a later init, or disconnected during the handshake: a
      // deliberate teardown, not a crash.
      if (g.__mentraBackgroundSession !== current || err instanceof NotConnectedError) return
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
