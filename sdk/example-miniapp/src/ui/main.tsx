import {createRoot} from "react-dom/client"
import "../shared/channels"

import App from "./App"
import "../index.css"

/**
 * WebView entry point. The `mentra` global is auto-injected by the host
 * via mentraUiShim — `shared/channels` augments its TypeScript declaration
 * with this miniapp's typed channel registry.
 *
 * No `MentraProvider` / `useSession` here — those belong to the previous
 * single-bundle world where the SDK ran inside the WebView. In the
 * two-layer architecture the WebView just talks to its background
 * JSContext via `mentra.send` / `mentra.on`. The background side owns
 * the session.
 */
const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(<App />)

// MUST call mentra.ready() on bootstrap so the host knows the WebView
// is mounted and the background-side session.ui.onOpen handlers fire.
mentra.ready()
