/**
 * UI WebView entry — Mentra AI chat interface (full cloud UI, local transport).
 *
 * Wraps the app in the local SDK's MentraProvider (no auth — that's a server
 * concept), wires the chat store/channel, and calls mentra.ready() so the
 * background's ui.onOpen fires (history hydration).
 */

import "../shared/channels"
import "./index.css"

import {StrictMode} from "react"
import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"

import App from "./App"

const elem = document.getElementById("root")
if (!elem) throw new Error("Root element not found")

createRoot(elem).render(
  <StrictMode>
    <MentraProvider>
      <App />
    </MentraProvider>
  </StrictMode>,
)

mentra.ready()
