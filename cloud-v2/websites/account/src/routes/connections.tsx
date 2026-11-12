import { useEffect, useRef, useState } from "react";
import { CONNECTIONS_SIGN_IN_PATH, type Connection, type ConnectionsApi } from "../lib/connections-api";
import { loadConnections, revokeConnection, type ConnectionsDeps, type ConnectionsState } from "../lib/connections-flow";
import { MESSAGES } from "../lib/messages";
import { describeScopes } from "../lib/scopes";
import { Loading, Notice, Page } from "../ui";

export interface ConnectionsRouteProps {
  api: ConnectionsApi;
  navigate: (url: string) => void;
  /** True when this page load is the return from sign-in. */
  returnedFromSignIn: boolean;
}

/** `/connections`: the miniapp websites the person has allowed to sign them in with Mentra. */
export function ConnectionsRoute({ api, navigate, returnedFromSignIn }: ConnectionsRouteProps) {
  const [state, setState] = useState<ConnectionsState>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const deps = useRef<ConnectionsDeps>({ api, navigate });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadConnections(deps.current, returnedFromSignIn).then(setState);
  }, [returnedFromSignIn]);

  switch (state.kind) {
    case "loading":
      return <Loading label="Loading…" />;
    case "redirecting":
      return <Loading label="Signing in…" />;
    case "sign-in-failed":
      return (
        <Page title="Connected apps">
          <Notice tone="error">{MESSAGES.connectionsSignInFailed}</Notice>
          <nav className="links" aria-label="Account">
            <a href={CONNECTIONS_SIGN_IN_PATH}>Sign in again</a>
          </nav>
        </Page>
      );
    case "error":
      return (
        <Page title="Connected apps">
          <Notice tone="error">{MESSAGES.connectionsFailed}</Notice>
        </Page>
      );
    case "list":
      return (
        <ConnectionsView
          connections={state.connections}
          notice={state.notice}
          busy={busy}
          onRevoke={(clientId) => {
            setBusy(clientId);
            void revokeConnection(deps.current, state.connections, clientId).then((next) => {
              setState(next);
              setBusy(null);
            });
          }}
        />
      );
  }
}

const GRANTED = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

/** "Allowed 11 Nov 2026"-style text; empty for a date Core did not send or that does not parse. */
export function grantedText(grantedAt: string | null): string {
  if (!grantedAt) return "";
  const date = new Date(grantedAt);
  return Number.isNaN(date.getTime()) ? "" : `Allowed ${GRANTED.format(date)}`;
}

export function ConnectionsView({
  connections,
  notice,
  busy,
  onRevoke,
}: {
  connections: Connection[];
  notice: "none" | "revoke-failed" | "rate-limited";
  /** The client being revoked, if any: every button waits for it. */
  busy: string | null;
  onRevoke: (clientId: string) => void;
}) {
  return (
    <Page title="Connected apps">
      <p className="muted">Sites you have allowed to sign you in with your Mentra account.</p>
      {notice === "revoke-failed" ? <Notice tone="error">{MESSAGES.revokeFailed}</Notice> : null}
      {notice === "rate-limited" ? <Notice tone="error">{MESSAGES.rateLimited}</Notice> : null}
      {connections.length === 0 ? (
        <Notice>{MESSAGES.noConnections}</Notice>
      ) : (
        <ul className="connections">
          {connections.map((connection) => (
            <li key={connection.clientId}>
              <div>
                <strong>{connection.name}</strong>
                <span className="muted">{describeScopes(connection.scopes).join(" · ")}</span>
                <span className="muted">{grantedText(connection.grantedAt)}</span>
              </div>
              <button
                className="button button-secondary"
                type="button"
                disabled={busy !== null}
                aria-label={`Revoke ${connection.name}`}
                onClick={() => onRevoke(connection.clientId)}
              >
                {busy === connection.clientId ? "Revoking…" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        Revoking signs the site out of your account within five minutes. It will ask again the next time you sign in there.
      </p>
      <nav className="links" aria-label="Account">
        <a href="/">Mentra account</a>
        <a href="/signout">Sign out</a>
      </nav>
    </Page>
  );
}
