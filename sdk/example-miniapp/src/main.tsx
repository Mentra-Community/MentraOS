import {createRoot} from "react-dom/client"
import {MentraProvider, useSession} from "@mentra/miniapp/react"

import App from "./App"
import {initGlassesController} from "./controller/GlassesController"
import "./index.css"

/**
 * Bootstrap shim — useSession() only works inside the React tree, so we
 * grab the shared session here and initialize the GlassesController on
 * first render. initGlassesController is idempotent so re-renders are
 * cheap. Children mount immediately after.
 *
 * This pattern keeps glasses behavior independent of React route
 * lifecycle: subscriptions belong to the controller, which lives as long
 * as the miniapp itself, NOT as long as a particular page is mounted.
 */
function Bootstrap() {
  const session = useSession()
  initGlassesController(session)
  return <App />
}

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider>
    <Bootstrap />
  </MentraProvider>,
)
