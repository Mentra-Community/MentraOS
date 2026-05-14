/**
 * @mentra/miniapp/ui — WebView-side SDK entry point.
 *
 * Imported from a miniapp's `src/ui/main.tsx` (or equivalent) to access
 * the `mentra` WebView global, React hooks, and the `MentraProvider`
 * wrapper. This is the **on-demand WebView side** of a Phase 4+ two-layer
 * miniapp.
 *
 * What's NOT in this entry point:
 *   - `MiniappSession` — background-only.
 *   - Any `session.*` module classes — background-only.
 *   - `__dispatch` / direct native access — by design, the WebView has
 *     no host-native APIs. All hardware calls go through the background
 *     bus via `mentra.send(channel, payload)`.
 *
 * The `mentra` global is injected into every UI WebView at mount time
 * by the host's `mentraUiShim` (see `@mentra/island/services/mentraUiShim`).
 * This entry point exports its TypeScript declaration so authors get
 * autocomplete and compile-time errors on channel names + payloads.
 */

// `mentra` lives on the global scope; declare it for TS so import
// `from "@mentra/miniapp/ui"` is enough to type-check `mentra.send(...)`.
declare global {
  // eslint-disable-next-line no-var
  var mentra: MentraUiGlobal
}

export interface MentraUiGlobal<TChannels extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Send a typed message to the bound background JSContext.
   *
   * Buffered until `ready()` acks; once acked, fires immediately. The
   * SDK never drops outbound user input — the WebView is the
   * short-lived side and may unmount before its messages flush.
   */
  send<C extends keyof TChannels & string>(channel: C, payload: TChannels[C]): void

  /**
   * Subscribe to messages from the background. Returns an unsubscribe
   * function. The handler persists across WebView open/close cycles
   * within a single mount; close-then-remount installs a fresh shim.
   */
  on<C extends keyof TChannels & string>(channel: C, cb: (payload: TChannels[C]) => void): () => void

  /**
   * Fires when the bridge is open and `mentra.send` is flushable. If
   * subscribed AFTER `ready()` has been called, fires immediately.
   */
  onOpen(cb: () => void): () => void

  /**
   * Fires when the host is about to destroy the WebView. Handlers
   * should snapshot any session state into background via
   * `mentra.send` if they want it to survive.
   */
  onClose(cb: () => void): () => void

  /**
   * MUST be called once on UI bootstrap. Tells the host the WebView is
   * mounted and ready to receive messages from background. Idempotent
   * — subsequent calls no-op. Background's `session.ui.onOpen` handlers
   * fire after this lands.
   */
  ready(): void
}

// React adapters are re-exported here so authors can import everything
// from a single sub-path. The actual hooks live in src/react/ and are
// already shipped as a separate sub-path for backwards-compat.
export {
  MentraProvider,
  type MentraProviderProps,
} from "../react/MentraProvider"
export {useSession} from "../react/useSession"
export {useColorScheme} from "../react/useColorScheme"
export {useCapabilities} from "../react/useCapabilities"
export {useConnected} from "../react/useConnected"
export {useSafeArea} from "../react/useSafeArea"
export {useVisibility} from "../react/useVisibility"
export {useCapsuleHeaderStyle} from "../react/useCapsuleHeaderStyle"

/**
 * Type helper for declaring a typed `mentra` global inside a miniapp.
 *
 * Usage in src/shared/channels.ts (or anywhere the type lives):
 *
 * ```ts
 * import type {MentraTyped} from "@mentra/miniapp/ui"
 * export type Channels = { 'add-note': {body: string} }
 * declare global {
 *   var mentra: MentraTyped<Channels>
 * }
 * ```
 */
export type MentraTyped<TChannels extends Record<string, unknown>> = MentraUiGlobal<TChannels>
