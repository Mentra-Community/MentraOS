import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"

import App from "./App"
import "./index.css"

/**
 * WebView entry point. The `mentra` global is auto-injected by the host via
 * mentraUiShim — `shared/channels` augments its TypeScript declaration with this
 * miniapp's typed channel registry.
 *
 * `<MentraProvider>` syncs the host color scheme onto `<html class="dark">`; it
 * does NOT construct a MiniappSession (that lives in the background JSContext).
 *
 * `mentra.ready()` MUST fire on bootstrap so the host knows the WebView is
 * mounted and the background-side session.ui.onOpen handler fires — that
 * handler pushes the full captions:snapshot used to hydrate the UI.
 */
const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)

mentra.ready()
