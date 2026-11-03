/**
 * WebView entry point. Imports the `mentra` global from the auto-injected
 * host shim and the typed `Channels` registry from src/shared/. The
 * WebView has zero direct native access — all hardware calls (glasses
 * display, sensors, BLE, etc.) go through `mentra.send(channel, payload)`
 * to background, which translates them into `session.*` SDK calls.
 */

import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"
import {App} from "./App"
import "./styles.css"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Missing #root element in index.html")
}

// MentraProvider syncs <html class="dark"> with the host color scheme and,
// once the app has mounted, calls mentra.ready() so the host hides its loading
// screen. It does NOT construct a MiniappSession.
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)
