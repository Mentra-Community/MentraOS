import { createRoot } from "react-dom/client";
import { createApp } from "./app";
import { readBuildConfig } from "./lib/config";

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    createApp(readBuildConfig(), {
      location: {
        origin: window.location.origin,
        pathname: window.location.pathname,
        search: window.location.search,
      },
      navigate: (url) => window.location.assign(url),
      storage: sessionStorageOrNull(),
    }),
  );
}
