/**
 * @fileoverview useCapabilities — React hook for the connected glasses'
 * capability profile.
 *
 * The glasses `GlassesCapabilities` profile is *background-only* state: it
 * arrives on the background `MiniappSession` (CONNECT_ACK / CAPABILITIES_UPDATE)
 * and is never injected into the UI WebView, so there is no WebView-side source
 * for it — this hook always returns `null`.
 *
 * If a UI page needs glasses capabilities, relay them from the background half
 * over an app channel: read `session.capabilities` in a `session.ui.onOpen`
 * handler, `session.ui.send("caps", ...)`, then read it in the UI with
 * `mentra.on("caps", ...)`. See the example miniapp's `captions:snapshot`
 * channel for the pattern.
 *
 * IMPORTANT: this hook must NOT construct a `MiniappSession`. That is the
 * *background* (JSContext) API; inside a UI WebView its `CONNECT` never gets an
 * ACK from the host's UI router and `session.connect()` times out
 * ("CONNECT_ACK timeout") — the original reason this hook was rewritten.
 *
 * (Note: `window.MentraOS.capabilities` is a different thing — host *feature*
 * flags like "share" / "open_url", not the glasses hardware profile.)
 */

import {type GlassesCapabilities} from "../session"

export function useCapabilities(): GlassesCapabilities | null {
  return null
}
