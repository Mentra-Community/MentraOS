import { useEffect, useRef, useState } from "react";
import {
  decideConsent,
  initialConsentState,
  startConsent,
  type ConsentDecision,
  type ConsentDeps,
  type ConsentDetails,
  type ConsentState,
} from "../lib/consent-flow";
import type { InteractionApi } from "../lib/interaction-api";
import { MESSAGES } from "../lib/messages";
import { Loading, Notice, Page } from "../ui";

export interface ConsentRouteProps {
  api: InteractionApi;
  navigate: (url: string) => void;
  search: string;
}

/** `/consent?interaction=…`: a third-party client asks to use the person's Mentra account. */
export function ConsentRoute({ api, navigate, search }: ConsentRouteProps) {
  const [state, setState] = useState<ConsentState>(() => initialConsentState(search));
  const [busy, setBusy] = useState(false);
  const deps = useRef<ConsentDeps>({ api, navigate });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startConsent(deps.current, search).then(setState);
  }, [search]);

  switch (state.kind) {
    case "loading":
      return <Loading label="Loading…" />;
    case "redirecting":
      return <Loading label="Continuing…" />;
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
    case "consent":
      return (
        <ConsentView
          consent={state.consent}
          busy={busy}
          onDecision={(decision) => {
            setBusy(true);
            void decideConsent(deps.current, state.interactionId, decision).then((next) => {
              setState(next);
              setBusy(false);
            });
          }}
        />
      );
  }
}

const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  openid: "Confirm who you are",
  email: "See your email address",
  profile: "See your name",
};

export function ConsentView({
  consent,
  busy,
  onDecision,
}: {
  consent: ConsentDetails;
  busy: boolean;
  onDecision: (decision: ConsentDecision) => void;
}) {
  return (
    <Page title={`Allow ${consent.clientName} to use your Mentra account?`}>
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
      <div className="actions">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => onDecision("deny")}>
          Deny
        </button>
        <button className="button button-primary" type="button" disabled={busy} onClick={() => onDecision("allow")}>
          Allow
        </button>
      </div>
    </Page>
  );
}
