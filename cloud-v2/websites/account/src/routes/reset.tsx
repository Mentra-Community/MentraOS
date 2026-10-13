import { useState, type FormEvent, type ReactNode } from "react";
import type { AccountApi, ResetResult } from "../lib/account-api";
import { loginPath, readInteractionId } from "../lib/links";
import { MESSAGES } from "../lib/messages";
import { Notice, Page, TextField } from "../ui";

export interface ResetRouteProps {
  api: AccountApi;
  search: string;
}

type Step = { kind: "request" } | { kind: "code"; email: string } | { kind: "updated" };

/**
 * `/reset`: password reset through Core's account API. Core emails a code;
 * the new password takes effect with it and ends every session of the
 * account, as any password reset does. The person then signs in again.
 */
export function ResetRoute({ api, search }: ResetRouteProps) {
  const [interactionId] = useState(() => readInteractionId(search));
  const [step, setStep] = useState<Step>({ kind: "request" });

  if (step.kind === "updated") {
    return (
      <Page title="Password updated">
        <Notice>{MESSAGES.passwordUpdated}</Notice>
        <BackToSignIn interactionId={interactionId}>Continue signing in</BackToSignIn>
      </Page>
    );
  }
  if (step.kind === "code") {
    return (
      <SetPasswordForm
        api={api}
        email={step.email}
        interactionId={interactionId}
        onUpdated={() => setStep({ kind: "updated" })}
        onStartOver={() => setStep({ kind: "request" })}
      />
    );
  }
  return <RequestResetForm api={api} interactionId={interactionId} onSent={(email) => setStep({ kind: "code", email })} />;
}

function BackToSignIn({ interactionId, children = "Back to sign in" }: { interactionId: string | null; children?: ReactNode }) {
  if (!interactionId) return null;
  return (
    <nav className="links" aria-label="Account help">
      <a href={loginPath(interactionId)}>{children}</a>
    </nav>
  );
}

function resetMessage(result: Exclude<ResetResult, { kind: "ok" }>): string {
  switch (result.kind) {
    case "invalid-code":
      return MESSAGES.invalidCode;
    case "weak-password":
      return MESSAGES.weakPassword;
    case "rate-limited":
      return MESSAGES.rateLimited;
    case "error":
      return MESSAGES.resetFailed;
  }
}

export function RequestResetForm({
  api,
  interactionId,
  onSent,
}: {
  api: AccountApi;
  interactionId: string | null;
  onSent: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const address = email.trim();
    const result = await api.requestReset(address);
    setBusy(false);
    if (result.kind === "ok") onSent(address);
    else setError(resetMessage(result));
  }

  return (
    <Page title="Reset your password">
      <p className="muted">Enter the email for your Mentra account. We will send you a code to set a new password.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="form" onSubmit={submit}>
        <TextField id="email" label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} disabled={busy} />
        <button className="button button-primary" type="submit" disabled={busy}>
          Send reset code
        </button>
      </form>
      <BackToSignIn interactionId={interactionId} />
    </Page>
  );
}

export function SetPasswordForm({
  api,
  email,
  interactionId,
  onUpdated,
  onStartOver,
}: {
  api: AccountApi;
  email: string;
  interactionId: string | null;
  onUpdated: () => void;
  onStartOver: () => void;
}) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await api.resetPassword({ email, code: code.trim(), newPassword: password });
    if (result.kind === "ok") return onUpdated();
    setBusy(false);
    setPassword("");
    setError(resetMessage(result));
  }

  return (
    <Page title="Set a new password">
      <Notice>{MESSAGES.resetSent}</Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="form" onSubmit={submit}>
        <TextField id="code" label="Reset code" type="text" autoComplete="one-time-code" value={code} onChange={setCode} disabled={busy} />
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
      <nav className="links" aria-label="Account help">
        <button className="link-button" type="button" disabled={busy} onClick={onStartOver}>
          Use a different email
        </button>
        {interactionId ? <a href={loginPath(interactionId)}>Back to sign in</a> : null}
      </nav>
    </Page>
  );
}
