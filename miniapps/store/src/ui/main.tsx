import React from "react"
import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"
import {App} from "./App"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MentraProvider>
      <App />
    </MentraProvider>
  </React.StrictMode>,
)
mentra.ready()
