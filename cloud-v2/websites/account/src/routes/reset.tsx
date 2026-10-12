import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { requestPasswordReset, updatePassword } from "../lib/account-actions";
import { authorizePath, readAuthorizationId } from "../lib/links";
import { MESSAGES } from "../lib/messages";
import type { RecoveryState } from "../lib/recovery";
import type { AccountAuthClient } from "../lib/supabase";
import { Loading, Notice, Page, TextField } from "../ui";

export interface ResetRouteProps {
  auth: AccountAuthClient;
  origin: string;
  search: string;
  recovery: RecoveryState;
}

type Outcome = "none" | "updated" | "expired";

/**
 * `/reset`: asks for a reset link, or, when the page was opened from that
 * link (a recovery session), sets a new password.
 */
export function ResetRoute({ auth, origin, search, recovery }: ResetRouteProps) {
  const [authorizationId] = useState(() => readAuthorizationId(search));
  const recovering = useSyncExternalStore(recovery.subscribe, recovery.isActive, recovery.isActive);
  // Wait for supabase-js to finish reading the link before choosing a form.
  const [ready, setReady] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("none");

  useEffect(() => {
    let active = true;
    auth
      .getSession()
      .then(({ data }) => {
        if (!data.session) recovery.clear();
      })
      .catch(() => recovery.clear())
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [auth, recovery]);

  const finish = (next: Outcome) => {
    setOutcome(next);
    recovery.clear();
  };

  if (outcome === "updated") return <PasswordUpdated authorizationId={authorizationId} />;
  if (!ready) return <Loading label="Loading…" />;
  if (recovering) {
    return <SetPasswordForm auth={auth} onUpdated={() => finish("updated")} onExpired={() => finish("expired")} />;
  }
  return (
    <RequestResetForm
      auth={auth}
      origin={origin}
      authorizationId={authorizationId}
      initialError={outcome === "expired" ? MESSAGES.resetExpired : null}
    />
  );
}

function BackToSignIn({ authorizationId, children = "Back to sign in" }: { authorizationId: string | null; children?: ReactNode }) {
  if (!authorizationId) return null;
  return (
    <nav className="links" aria-label="Account help">
      <a href={authorizePath(authorizationId)}>{children}</a>
    </nav>
  );
}

export function RequestResetForm({
  auth,
  origin,
  authorizationId,
  initialError = null,
}: {
  auth: AccountAuthClient;
  origin: string;
  authorizationId: string | null;
  initialError?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(auth, { email: email.trim(), origin, authorizationId });
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(result.message);
  }

  if (sent) {
    return (
      <Page title="Check your email">
        <Notice>{MESSAGES.resetSent}</Notice>
        <BackToSignIn authorizationId={authorizationId} />
      </Page>
    );
  }

  return (
    <Page title="Reset your password">
      <p className="muted">Enter the email for your Mentra account. We will send you a link to set a new password.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="form" onSubmit={submit}>
        <TextField id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} disabled={busy} />
        <button className="button button-primary" type="submit" disabled={busy}>
          Send reset link
        </button>
      </form>
      <BackToSignIn authorizationId={authorizationId} />
    </Page>
  );
}

export function SetPasswordForm({
  auth,
  onUpdated,
  onExpired,
}: {
  auth: AccountAuthClient;
  onUpdated: () => void;
  onExpired: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await updatePassword(auth, password);
    if (result.ok) return onUpdated();
    if (result.expired) return onExpired();
    setBusy(false);
    setPassword("");
    setError(result.message);
  }

  return (
    <Page title="Set a new password">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="form" onSubmit={submit}>
        <TextField
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          disabled={busy}
        />
        <button className="button button-primary" type="submit" disabled={busy}>
          Save password
        </button>
      </form>
    </Page>
  );
}

function PasswordUpdated({ authorizationId }: { authorizationId: string | null }) {
  return (
    <Page title="Password updated">
      <Notice>{MESSAGES.passwordUpdated}</Notice>
      <BackToSignIn authorizationId={authorizationId}>Continue signing in</BackToSignIn>
    </Page>
  );
}
