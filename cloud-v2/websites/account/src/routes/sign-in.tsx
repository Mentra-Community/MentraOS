import { useState, type FormEvent } from "react";
import { signInWithEmail, startSocialSignIn } from "../lib/account-actions";
import { resetPath, signUpPath } from "../lib/links";
import type { AccountAuthClient, SocialProvider } from "../lib/supabase";
import { Notice, Page, TextField } from "../ui";

export interface SignInViewProps {
  auth: AccountAuthClient;
  origin: string;
  /** The authorization request to continue after sign-in. */
  authorizationId: string;
  /** Called after a successful email and password sign-in. */
  onSignedIn: () => void;
}

export function SignInView({ auth, origin, authorizationId, onSignedIn }: SignInViewProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await signInWithEmail(auth, email.trim(), password);
    if (result.ok) {
      setPassword("");
      onSignedIn();
      return;
    }
    setBusy(false);
    setError(result.message);
  }

  async function continueWith(provider: SocialProvider) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await startSocialSignIn(auth, provider, origin, authorizationId);
    // On success supabase-js navigates to the provider; keep the buttons disabled.
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
    }
  }

  return (
    <Page title="Sign in to your Mentra account">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="form" onSubmit={submit}>
        <TextField id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} disabled={busy} />
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          disabled={busy}
        />
        <button className="button button-primary" type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
      <p className="divider">or</p>
      <div className="stack">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => continueWith("google")}>
          Continue with Google
        </button>
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => continueWith("apple")}>
          Continue with Apple
        </button>
      </div>
      <nav className="links" aria-label="Account help">
        <a href={signUpPath(authorizationId)}>Create a Mentra account</a>
        <a href={resetPath(authorizationId)}>Forgot your password?</a>
      </nav>
    </Page>
  );
}
