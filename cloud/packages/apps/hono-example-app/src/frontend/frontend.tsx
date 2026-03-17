/**
 * Frontend Entry Point
 *
 * This file is the entry point for the React app.
 * It is included in `index.html` and bundled by Bun.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MentraAuthProvider } from "@mentra/react";

import "./index.css";

import App from "./App";

const elem = document.getElementById("root")!;

const app = (
  <StrictMode>
    <MentraAuthProvider>
      <App />
    </MentraAuthProvider>
  </StrictMode>
);

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  // The hot module reloading API is not available in production.
  createRoot(elem).render(app);
}
