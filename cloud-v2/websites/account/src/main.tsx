import { createRoot } from "react-dom/client";
import { createApp } from "./app";
import { readBuildConfig } from "./lib/config";
import { readEmailLinkLanding } from "./lib/email-link";
import { matchRoute } from "./lib/router";

// Read and remove an email link's fragment before the Supabase client is
// created, so its tokens neither start a session here nor stay in history.
const emailLink = readEmailLinkLanding(window.location.hash);
if (emailLink) window.history.replaceState(null, "", window.location.pathname + window.location.search);

// Connected apps comes back from sign-in with a code in its query. The page never redeems it (the session
// cookie is what it needs), so it leaves the address bar and history before anything else runs.
const search = window.location.search;
if (matchRoute(window.location.pathname) === "connections" && search) {
  window.history.replaceState(null, "", window.location.pathname);
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    createApp(readBuildConfig(), {
      location: {
        origin: window.location.origin,
        pathname: window.location.pathname,
        search,
      },
      navigate: (url) => window.location.assign(url),
      emailLink,
    }),
  );
}
