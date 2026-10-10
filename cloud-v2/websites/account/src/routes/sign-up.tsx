import { useState, type FormEvent } from "react";
import { signUpWithEmail } from "../lib/account-actions";
import { authorizePath, readAuthorizationId } from "../lib/links";
import { MESSAGES } from "../lib/messages";
import type { AccountAuthClient } from "../lib/supabase";
import { Notice, Page, TextField } from "../ui";

export interface SignUpRouteProps {
  auth: AccountAuthClient;
  origin: string;
  search: string;
  navigate: (url: string) => void;
}

/** `/signup`, optionally continuing an authorization request. */
export function SignUpRoute({ auth, origin, search, navigate }: SignUpRouteProps) {
  const [authorizationId] = useState(() => readAuthorizationId(search));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await signUpWithEmail(auth, { email: email.trim(), password, origin, authorizationId });
    if (result.kind === "signed-in") {
      navigate(authorizationId ? authorizePath(authorizationId) : "/");
      return;
    }
    setBusy(false);
    setPassword("");
    if (result.kind === "check-email") setSent(true);
    else setError(result.message);
  }

  const backToSignIn = authorizationId ? (
    <nav className="links" aria-label="Account help">
      <a href={authorizePath(authorizationId)}>Back to sign in</a>
    </nav>
  ) : null;

  if (sent) {
    return (
      <Page title="Confirm your email">
        <Notice>{MESSAGES.checkEmail}</Notice>
        {backToSignIn}
      </Page>
    );
  }

  return (
    <Page title="Create your Mentra account">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="form" onSubmit={submit}>
        <TextField id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} disabled={busy} />
        <TextField
          id="new-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          disabled={busy}
        />
        <button className="button button-primary" type="submit" disabled={busy}>
          Create account
        </button>
      </form>
      {backToSignIn}
    </Page>
  );
}
