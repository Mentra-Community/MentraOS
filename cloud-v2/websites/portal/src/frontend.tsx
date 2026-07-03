import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const elem = document.getElementById("root");
if (!elem) throw new Error("root element missing");

(import.meta.hot.data.root ??= createRoot(elem)).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
