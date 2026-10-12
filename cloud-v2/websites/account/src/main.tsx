import { createRoot } from "react-dom/client";
import { createApp } from "./app";
import { readBuildConfig } from "./lib/config";
import { readEmailLinkLanding } from "./lib/email-link";

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// Read and remove an email link's fragment before the Supabase client is
// created, so its tokens neither start a session here nor stay in history.
const emailLink = readEmailLinkLanding(window.location.hash);
if (emailLink) window.history.replaceState(null, "", window.location.pathname + window.location.search);

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
      emailLink,
    }),
  );
}
