/** Small building blocks shared by the workspace panels. */

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../errors";
import { cn } from "../lib/utils";
import { ROLE_LABELS } from "../roles";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import type { WorkspaceRole } from "@mentra/workspace-contract";

/** A titled card holding one panel's content, with an optional count beside the title and actions on the right. */
export function Panel({
  title,
  description,
  count,
  actions,
  className,
  children,
}: {
  title: string;
  description?: string;
  /** How many items the panel lists, once known. */
  count?: number;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card role="region" aria-label={title} className={cn("gap-5", className)}>
      <CardHeader className={actions ? "grid-cols-[1fr_auto]" : undefined}>
        <CardTitle className="flex items-center gap-2 text-base">
          {title}
          {count !== undefined ? (
            <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
              {count}
            </span>
          ) : null}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {actions ? <div className="col-start-2 row-span-2 row-start-1 self-center">{actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/** Up to two letters for an email address or a name: "olivia.lee@acme.test" is "OL", "Acme Field Team" is "AF". */
export function initials(value: string): string {
  const base = value.includes("@") ? value.split("@")[0]! : value;
  const letters = base
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!)
    .join("");
  return (letters || base.slice(0, 1) || "?").slice(0, 2).toUpperCase();
}

/** A round badge with a person's initials (or a workspace's first letter, `single`), in place of a picture. */
export function Avatar({ label, single = false, className }: { label: string; single?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-secondary text-secondary-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        className,
      )}
    >
      {single ? initials(label).slice(0, 1) : initials(label)}
    </span>
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

/**
 * The loading and failed-load states every panel shares. The data is shown whenever there is any: a
 * background refetch that fails (the connection dropped, a 5xx) keeps what was already loaded rather
 * than replacing the panel with an error. Only a query that has no data yet shows Loading, or, once it
 * has failed, the error with a retry. Pass only queries that are enabled: a disabled one has no data and
 * would read as loading for ever.
 */
export function QueryGate<T>({
  result,
  loadingLabel,
  children,
}: {
  result: { data: T | undefined; isError: boolean; error: unknown; refetch: () => unknown };
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (result.data !== undefined) return <>{children(result.data)}</>;
  if (result.isError) return <LoadError error={result.error} onRetry={() => void result.refetch()} />;
  return <Loading>{loadingLabel}</Loading>;
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
 * Focus lands on Cancel so a stray Enter backs out, and returns to the trigger when the prompt closes.
 */
export function ConfirmButton({
  label,
  ariaLabel,
  prompt,
  confirmLabel,
  disabled,
  outline = false,
  onConfirm,
}: {
  label: string;
  ariaLabel: string;
  prompt: string;
  confirmLabel: string;
  disabled?: boolean;
  /** An outlined trigger, for a destructive action that stands on its own row (a danger zone). */
  outline?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  // The trigger is swapped for the prompt while confirming, so focus would otherwise fall to the page.
  useEffect(() => {
    if (!confirming && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);
  const close = () => {
    restoreFocus.current = true;
    setConfirming(false);
  };
  if (!confirming) {
    return (
      <Button
        ref={trigger}
        type="button"
        variant={outline ? "outline" : "ghost"}
        size="sm"
        className={cn(
          "text-destructive hover:text-destructive",
          outline && "border-destructive/40 hover:bg-destructive/5 hover:border-destructive/60",
        )}
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
          close();
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="outline" size="sm" autoFocus onClick={close}>
        Cancel
      </Button>
    </span>
  );
}

/** Copies `text` to the clipboard and says whether it worked. */
export function CopyButton({ text, label = "Copy", ariaLabel }: { text: string; label?: string; ariaLabel?: string }) {
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
    <Button type="button" variant="outline" size="sm" aria-label={ariaLabel} onClick={copy}>
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
