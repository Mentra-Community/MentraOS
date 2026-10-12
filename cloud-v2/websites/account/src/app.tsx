import type { ReactElement } from "react";
import { isConfigured, type AccountConfig } from "./lib/config";
import type { EmailLinkLanding } from "./lib/email-link";
import { createRecoveryState } from "./lib/recovery";
import { matchRoute } from "./lib/router";
import { createAccountAuthClient, type AccountAuthClient } from "./lib/supabase";
import { AuthorizeRoute } from "./routes/authorize";
import { HomeRoute } from "./routes/home";
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
  /** Session storage for the password-recovery flag. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Defaults to the real Supabase client; tests pass a fake. */
  createAuth?: (config: AccountConfig) => AccountAuthClient;
  /** The outcome of an email link that fell back to the Site URL, already removed from the URL. */
  emailLink?: EmailLinkLanding | null;
}

/**
 * Builds the page for the current URL. Without Supabase configuration every
 * route shows a fixed message and no client is created.
 */
export function createApp(config: AccountConfig, env: AppEnvironment): ReactElement {
  // An email link's outcome needs no Supabase client and starts no session.
  if (env.emailLink && matchRoute(env.location.pathname) === "home") return <EmailLinkResult landing={env.emailLink} />;
  if (!isConfigured(config)) return <NotConfigured />;

  let auth: AccountAuthClient;
  try {
    auth = (env.createAuth ?? createAccountAuthClient)(config);
  } catch {
    return <NotConfigured />;
  }

  // Attach the recovery listener before the first render so the
  // PASSWORD_RECOVERY event from a reset link is never missed.
  const recovery = createRecoveryState(auth, env.storage);
  const { origin, pathname, search } = env.location;

  let page: ReactElement;
  switch (matchRoute(pathname)) {
    case "authorize":
      page = (
        <AuthorizeRoute
          auth={auth}
          firstPartyClientIds={config.firstPartyClientIds}
          navigate={env.navigate}
          origin={origin}
          search={search}
        />
      );
      break;
    case "signup":
      page = <SignUpRoute auth={auth} origin={origin} search={search} navigate={env.navigate} />;
      break;
    case "reset":
      page = <ResetRoute auth={auth} origin={origin} search={search} recovery={recovery} />;
      break;
    case "signout":
      page = <SignOutRoute auth={auth} />;
      break;
    case "home":
      page = <HomeRoute auth={auth} />;
      break;
    case "not-found":
      page = <NotFound />;
      break;
  }

  return <ErrorBoundary>{page}</ErrorBoundary>;
}
