import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MentraAuthProvider } from "@mentra/react";

import "./index.css";

import App from "./App";
import { MentraStateProvider } from "./mentra-state";

const element = document.getElementById("root");

if (!element) {
  throw new Error("Root element not found");
}

const app = (
  <StrictMode>
    <MentraAuthProvider>
      <MentraStateProvider>
        <App />
      </MentraStateProvider>
    </MentraAuthProvider>
  </StrictMode>
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(element));
  root.render(app);
} else {
  createRoot(element).render(app);
}
