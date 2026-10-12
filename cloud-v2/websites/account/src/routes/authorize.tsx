import { useCallback, useEffect, useRef, useState } from "react";
import {
  completeAuthorization,
  decideAuthorization,
  initialAuthorizeState,
  startAuthorization,
  switchAccount,
  type AuthorizeDecision,
  type AuthorizeDeps,
  type AuthorizeState,
  type ConsentDetails,
} from "../lib/authorize-flow";
import { readAuthorizationId } from "../lib/links";
import { MESSAGES } from "../lib/messages";
import type { AccountAuthClient } from "../lib/supabase";
import { Loading, Notice, Page } from "../ui";
import { SignInView } from "./sign-in";

export interface AuthorizeRouteProps extends AuthorizeDeps {
  origin: string;
  search: string;
}

/** `/oauth/authorize?authorization_id=…`, the Supabase OAuth 2.1 authorization page. */
export function AuthorizeRoute({ auth, firstPartyClientIds, navigate, origin, search }: AuthorizeRouteProps) {
  const [authorizationId] = useState(() => readAuthorizationId(search));
  const [state, setState] = useState<AuthorizeState>(() => initialAuthorizeState(search));
  const [busy, setBusy] = useState(false);
  const deps = useRef<AuthorizeDeps>({ auth, firstPartyClientIds, navigate });
  const started = useRef(false);

  const run = useCallback(
    async (step: (deps: AuthorizeDeps, id: string) => Promise<AuthorizeState>) => {
      if (!authorizationId) return;
      setBusy(true);
      const next = await step(deps.current, authorizationId);
      setState(next);
      setBusy(false);
    },
    [authorizationId],
  );

  useEffect(() => {
    // Run once per page load: approving twice would fail the second time.
    if (started.current) return;
    started.current = true;
    void startAuthorization(deps.current, search).then(setState);
  }, [search]);

  return (
    <AuthorizeView
      state={state}
      auth={auth}
      origin={origin}
      busy={busy}
      onSignedIn={() => {
        setState({ kind: "loading" });
        void run(completeAuthorization);
      }}
      onDecision={(decision) => void run((d, id) => decideAuthorization(d, id, decision))}
      onSwitchAccount={() => void run(switchAccount)}
    />
  );
}

export interface AuthorizeViewProps {
  state: AuthorizeState;
  auth: AccountAuthClient;
  origin: string;
  busy?: boolean;
  onSignedIn: () => void;
  onDecision: (decision: AuthorizeDecision) => void;
  onSwitchAccount: () => void;
}

export function AuthorizeView({ state, auth, origin, busy = false, onSignedIn, onDecision, onSwitchAccount }: AuthorizeViewProps) {
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
    case "error":
      return (
        <Page title="Sign-in did not finish">
          <Notice tone="error">{MESSAGES.authorizeFailed}</Notice>
        </Page>
      );
    case "sign-in":
      return (
        <SignInView
          key={state.authorizationId}
          auth={auth}
          origin={origin}
          authorizationId={state.authorizationId}
          onSignedIn={onSignedIn}
        />
      );
    case "consent":
      return (
        <ConsentView consent={state.consent} busy={busy} onDecision={onDecision} onSwitchAccount={onSwitchAccount} />
      );
  }
}

const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  openid: "Confirm who you are",
  email: "See your email address",
  profile: "See your name and profile picture",
  phone: "See your phone number",
};

export function ConsentView({
  consent,
  busy,
  onDecision,
  onSwitchAccount,
}: {
  consent: ConsentDetails;
  busy: boolean;
  onDecision: (decision: AuthorizeDecision) => void;
  onSwitchAccount: () => void;
}) {
  return (
    <Page title={`Allow ${consent.clientName} to use your Mentra account?`}>
      {consent.email ? (
        <p className="muted">
          Signed in as <strong>{consent.email}</strong>
        </p>
      ) : null}
      {consent.scopes.length > 0 ? (
        <>
          <p>{consent.clientName} will be able to:</p>
          <ul className="scopes">
            {consent.scopes.map((scope) => (
              <li key={scope}>{SCOPE_DESCRIPTIONS[scope] ?? scope}</li>
            ))}
          </ul>
        </>
      ) : null}
      {consent.redirectUri ? (
        <p className="muted">
          After you choose, you go to <span className="uri">{consent.redirectUri}</span>
        </p>
      ) : null}
      <div className="actions">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => onDecision("deny")}>
          Deny
        </button>
        <button className="button button-primary" type="button" disabled={busy} onClick={() => onDecision("allow")}>
          Allow
        </button>
      </div>
      <button className="link-button" type="button" disabled={busy} onClick={onSwitchAccount}>
        Use a different account
      </button>
    </Page>
  );
}
