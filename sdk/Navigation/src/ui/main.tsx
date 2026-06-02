/**
 * UI entry point — Mentra Map miniapp.
 *
 * Mounts React, installs root-level channel subscribers feeding the
 * Zustand store, fires `mentra.ready()` so background's
 * session.ui.onOpen handlers fire. The store is the only seam between
 * the channel bus and the React tree.
 */

import "../shared/channels"
import "./index.css"

import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"

import App from "./App"
import {installChannelSubscribers} from "./store/navStore"

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)

installChannelSubscribers()

mentra.ready()
