/**
 * webview/main.tsx
 *
 * Entry point. Imports `client/index.ts` for its side effects (state
 * init, transcription subscription, exposeClient registration), then
 * mounts the React tree.
 *
 * In v0 of the framework the developer writes this 4-line bootstrap.
 * In v1 the CLI generates it; the developer only writes `client/` and
 * `webview/`.
 */

import "../client"
import {createRoot} from "react-dom/client"
import App from "./App"

createRoot(document.getElementById("root")!).render(<App />)
