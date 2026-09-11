import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"

import App from "./App"
import "../index.css"

/**
 * WebView entry point. The `mentra` global is auto-injected by the host
 * via mentraUiShim — `shared/channels` augments its TypeScript declaration
 * with this miniapp's typed channel registry.
 *
 * `<MentraProvider>` is purely a CSS theme sync (it toggles
 * `<html class="dark">` based on the host color scheme via the
 * window.MentraOS globals the host still injects into every WebView).
 * It does NOT construct a `MiniappSession` — that lives in background
 * now. Keeping the provider in the two-layer world avoids a regression
 * from the single-bundle version where dark mode just worked.
 *
 * `useSession` is NOT used on the WebView side anymore — all glasses
 * logic talks to background via `mentra.send` / `mentra.on`.
 */
const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)

// MUST call mentra.ready() on bootstrap so the host knows the WebView
// is mounted and the background-side session.ui.onOpen handlers fire.
mentra.ready()
