import { Component, type ChangeEvent, type ReactNode } from "react";
import type { EmailLinkLanding } from "./lib/email-link";
import { MESSAGES } from "./lib/messages";

export function Page({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="page">
      <div className="card">
        <p className="wordmark">Mentra</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p className={tone === "error" ? "notice notice-error" : "notice"} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function TextField(props: {
  id: string;
  label: string;
  type: "email" | "password";
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        name={props.id}
        type={props.type}
        autoComplete={props.autoComplete}
        value={props.value}
        required
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
    </div>
  );
}

export function NotConfigured() {
  return (
    <Page title="Mentra account">
      <Notice tone="error">{MESSAGES.notConfigured}</Notice>
    </Page>
  );
}

export function EmailLinkResult({ landing }: { landing: EmailLinkLanding }) {
  return landing.kind === "verified" ? (
    <Page title="Email verified">
      <p className="muted">{MESSAGES.emailVerified}</p>
    </Page>
  ) : (
    <Page title="Link expired">
      <Notice tone="error">{MESSAGES.emailLinkFailed}</Notice>
    </Page>
  );
}

export function NotFound() {
  return <Page title={MESSAGES.notFound} />;
}

export function Loading({ label }: { label: string }) {
  return (
    <Page title="Mentra account">
      <p className="muted" role="status">
        {label}
      </p>
    </Page>
  );
}

/** Shows a fixed message instead of a blank page if rendering throws. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <Page title="Mentra account">
          <Notice tone="error">{MESSAGES.unexpected}</Notice>
        </Page>
      );
    }
    return this.props.children;
  }
}
