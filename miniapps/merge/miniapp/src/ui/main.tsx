import {MentraProvider} from "@mentra/miniapp/ui"
import {createRoot} from "react-dom/client"

import "../shared/channels"
import App from "./App"
import "./index.css"

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")

createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)

mentra.ready()
