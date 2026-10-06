/** Small building blocks shared by the workspace panels. */

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../errors";
import { cn } from "../lib/utils";
import { ROLE_LABELS } from "../roles";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import type { WorkspaceRole } from "@mentra/workspace-contract";

/** A titled card holding one panel's content. */
export function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card role="region" aria-label={title}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export function Loading({ children = "Loading…" }: { children?: string }) {
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {children}
    </p>
  );
}

/** Why the viewer is not shown something. Controls and data are left out, not greyed out. */
export function Restricted({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

/** The failure of the last action, in words. Renders nothing when there is none. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {errorMessage(error)}
    </p>
  );
}

/** A failed load, with a way to try again. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ErrorNotice error={error} />
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function RoleBadge({ role, className }: { role: WorkspaceRole; className?: string }) {
  return (
    <span
      className={cn(
        "bg-secondary text-secondary-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "border-border text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-xs",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A destructive action behind an inline confirm step: the first click only asks, the second does it.
 * Focus lands on Cancel so a stray Enter backs out.
 */
export function ConfirmButton({
  label,
  ariaLabel,
  prompt,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  ariaLabel: string;
  prompt: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <span role="group" aria-label={ariaLabel} className="inline-flex flex-wrap items-center gap-2">
      <span className="text-sm">{prompt}</span>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="outline" size="sm" autoFocus onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** Copies `text` to the clipboard and says whether it worked. */
export function CopyButton({ text, label = "Copy", autoFocus }: { text: string; label?: string; autoFocus?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // No clipboard in this context (an insecure page, a denied permission): the text is still on screen.
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 3000);
  }

  return (
    <Button type="button" variant="outline" size="sm" autoFocus={autoFocus} onClick={copy}>
      {state === "copied" ? (
        <>
          <CheckIcon /> Copied
        </>
      ) : state === "failed" ? (
        "Copy failed: select the text and copy it yourself"
      ) : (
        <>
          <CopyIcon /> {label}
        </>
      )}
    </Button>
  );
}
