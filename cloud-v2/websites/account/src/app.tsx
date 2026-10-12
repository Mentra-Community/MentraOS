import type { ReactElement } from "react";
import { createAccountApi, type AccountApi } from "./lib/account-api";
import { isConfigured, type AccountConfig } from "./lib/config";
import type { EmailLinkLanding } from "./lib/email-link";
import { createInteractionApi, type InteractionApi } from "./lib/interaction-api";
import { matchRoute } from "./lib/router";
import { createAccountAuthClient, type AccountAuthClient } from "./lib/supabase";
import { ConsentRoute } from "./routes/consent";
import { HomeRoute } from "./routes/home";
import { LoginRoute } from "./routes/login";
import { ResetRoute } from "./routes/reset";
import { SignOutRoute } from "./routes/signout";
import { SignUpRoute } from "./routes/sign-up";
import { EmailLinkResult, ErrorBoundary, NotConfigured, NotFound } from "./ui";

export interface PageLocation {
  origin: string;
  pathname: string;
  search: string;
}

export interface AppEnvironment {
  location: PageLocation;
  navigate: (url: string) => void;
  /** Defaults to the real Supabase client; tests pass a fake. */
  createAuth?: (config: AccountConfig) => AccountAuthClient;
  /** Core's sign-in server on this origin; tests pass a fake. */
  interactions?: InteractionApi;
  /** Core's account API on this origin; tests pass a fake. */
  account?: AccountApi;
  /** The outcome of an email link that fell back to the Site URL, already removed from the URL. */
  emailLink?: EmailLinkLanding | null;
}

/**
 * Builds the page for the current URL: the login UI of Core's sign-in server
 * for this environment. Routes that sign in need Supabase configuration;
 * without it they show a fixed message and no client is created.
 */
export function createApp(config: AccountConfig, env: AppEnvironment): ReactElement {
  const route = matchRoute(env.location.pathname);
  // An email link's outcome needs no Supabase client and starts no session.
  if (env.emailLink && route === "home") return <EmailLinkResult landing={env.emailLink} />;

  const { origin, search } = env.location;
  const interactions = env.interactions ?? createInteractionApi(origin);
  let page: ReactElement;
  switch (route) {
    case "home":
      page = <HomeRoute />;
      break;
    case "signout":
      page = <SignOutRoute navigate={env.navigate} />;
      break;
    case "consent":
      page = <ConsentRoute api={interactions} navigate={env.navigate} search={search} />;
      break;
    case "reset":
      page = <ResetRoute api={env.account ?? createAccountApi()} search={search} />;
      break;
    case "login":
    case "signup": {
      if (!isConfigured(config)) return <NotConfigured />;
      let auth: AccountAuthClient;
      try {
        auth = (env.createAuth ?? createAccountAuthClient)(config);
      } catch {
        return <NotConfigured />;
      }
      page =
        route === "login" ? (
          <LoginRoute auth={auth} api={interactions} navigate={env.navigate} origin={origin} search={search} />
        ) : (
          <SignUpRoute auth={auth} origin={origin} search={search} navigate={env.navigate} />
        );
      break;
    }
    case "not-found":
      page = <NotFound />;
      break;
  }

  return <ErrorBoundary>{page}</ErrorBoundary>;
}
