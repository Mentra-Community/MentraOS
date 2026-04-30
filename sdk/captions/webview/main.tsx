/**
 * webview/main.tsx
 *
 * Entry point. Imports `client/index.ts` for its side effects
 * (state init, transcription subscription, exposeClient registration),
 * then mounts React.
 */

import "../client"
import {createRoot} from "react-dom/client"
import App from "./App"
import "./index.css"

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(<App />)
