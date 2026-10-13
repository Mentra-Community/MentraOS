import { useCallback, useEffect, useRef, useState } from "react";
import type { InteractionApi } from "../lib/interaction-api";
import { continueAfterSignIn, initialLoginState, startLogin, type LoginDeps, type LoginState } from "../lib/login-flow";
import { MESSAGES } from "../lib/messages";
import type { AccountAuthClient } from "../lib/supabase";
import { Loading, Notice, Page } from "../ui";
import { SignInView } from "./sign-in";

export interface LoginRouteProps {
  auth: AccountAuthClient;
  api: InteractionApi;
  navigate: (url: string) => void;
  origin: string;
  search: string;
}

/** `/login?interaction=…`, the login step of Core's sign-in server. */
export function LoginRoute({ auth, api, navigate, origin, search }: LoginRouteProps) {
  const [state, setState] = useState<LoginState>(() => initialLoginState(search));
  const deps = useRef<LoginDeps>({ auth, api, navigate });
  const started = useRef(false);

  useEffect(() => {
    // Run once per page load: a hand-off can be used only once.
    if (started.current) return;
    started.current = true;
    void startLogin(deps.current, search).then(setState);
  }, [search]);

  const onSignedIn = useCallback((interactionId: string, clientName: string) => {
    setState({ kind: "loading" });
    void continueAfterSignIn(deps.current, interactionId, clientName).then(setState);
  }, []);

  return <LoginView state={state} auth={auth} origin={origin} onSignedIn={onSignedIn} />;
}

export function LoginView({
  state,
  auth,
  origin,
  onSignedIn,
}: {
  state: LoginState;
  auth: AccountAuthClient;
  origin: string;
  onSignedIn: (interactionId: string, clientName: string) => void;
}) {
  switch (state.kind) {
    case "loading":
      return <Loading label="Checking your sign-in…" />;
    case "redirecting":
      return <Loading label="Signing you in…" />;
    case "invalid":
      return (
        <Page title="Sign-in link not valid">
          <Notice tone="error">{MESSAGES.invalidLink}</Notice>
        </Page>
      );
    case "expired":
      return (
        <Page title="Sign-in expired">
          <Notice tone="error">{MESSAGES.signInExpired}</Notice>
        </Page>
      );
    case "error":
      return (
        <Page title="Sign-in did not finish">
          <Notice tone="error">{MESSAGES.authorizeFailed}</Notice>
        </Page>
      );
    case "sign-in":
      return (
        <SignInView
          key={state.interactionId}
          auth={auth}
          origin={origin}
          interactionId={state.interactionId}
          clientName={state.clientName}
          initialError={state.error}
          onSignedIn={() => onSignedIn(state.interactionId, state.clientName)}
        />
      );
  }
}
