/**
 * Frontend entry. Bundled into the WebView via index.html.
 */

import {createRoot} from "react-dom/client"

import App from "./App"
import "./index.css"

createRoot(document.getElementById("root")!).render(<App />)
