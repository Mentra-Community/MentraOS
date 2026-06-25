import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"

import App from "./App"
import "../index.css"

/**
 * WebView entry point. The `mentra` global is injected by the host; the
 * gallery is an editorial light surface (the full-screen viewer goes dark per
 * screen, not via the host color scheme), so we opt out of MentraProvider's
 * color-scheme sync.
 */
const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider syncColorScheme={false}>
    <App />
  </MentraProvider>,
)

mentra.ready()
