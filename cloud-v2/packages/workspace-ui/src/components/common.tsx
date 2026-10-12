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
        <CardTitle className="flex items-center gap-2 text-lg">
          {title}
          {count !== undefined ? <Count>{count}</Count> : null}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {actions ? <div className="col-start-2 row-span-2 row-start-1 self-center">{actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/** How many there are, beside a heading: "Members 5", "Pending invitations 2". */
export function Count({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "bg-surface text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs leading-none font-semibold tabular-nums",
        className,
      )}
    >
      {children}
    </span>
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
        "border-border bg-surface text-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
        className,
      )}
    >
      {single ? initials(label).slice(0, 1) : initials(label)}
    </span>
  );
}

/**
 * A workspace's first letter on a rounded green tile, in place of a logo (the Store's fallback app icon).
 * Size it with `className` (`size-9 rounded-[10px] text-sm`).
 */
export function WorkspaceAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-info text-info-foreground inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] text-base font-semibold",
        className,
      )}
    >
      {initials(name).slice(0, 1)}
    </span>
  );
}

/** The sign-in page's spinner, with what is loading. */
export function Loading({ children = "Loading…" }: { children?: string }) {
  return (
    <p role="status" className="text-muted-foreground flex items-center gap-2.5 text-sm">
      <Spinner />
      {children}
    </p>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "border-border border-t-brand inline-block size-4 shrink-0 animate-spin rounded-full border-2 motion-reduce:[animation-duration:2.4s]",
        className,
      )}
    />
  );
}

/** Why the viewer is not shown something. Controls and data are left out, not greyed out. */
export function Restricted({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

/** The failure of the last action, in words, as the sign-in page's error notice. Renders nothing when there is none. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
      {errorMessage(error)}
    </p>
  );
}

/** A failed load, with a way to try again. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ErrorNotice error={error} />
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
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

/** A role as a grey chip. */
export function RoleBadge({ role, className }: { role: WorkspaceRole; className?: string }) {
  return (
    <span
      className={cn(
        "bg-surface text-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs leading-none font-semibold whitespace-nowrap",
        className,
      )}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}

/** A small outlined chip ("You"). */
export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "border-border text-muted-foreground inline-flex h-6 items-center rounded-full border px-2.5 text-xs leading-none font-semibold whitespace-nowrap",
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
  /** Full-size buttons, for a destructive action that stands on its own row (a danger zone) rather than in a list. */
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
        variant="destructive-secondary"
        size={outline ? "default" : "sm"}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className={cn("inline-flex flex-wrap items-center justify-end gap-2", !outline && "max-w-[19rem]")}
    >
      <span className={cn("text-sm", !outline && "basis-full text-right")}>{prompt}</span>
      <Button
        type="button"
        variant="destructive"
        size={outline ? "default" : "sm"}
        disabled={disabled}
        onClick={() => {
          close();
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="secondary" size={outline ? "default" : "sm"} autoFocus onClick={close}>
        Cancel
      </Button>
    </span>
  );
}

/** Copies `text` to the clipboard and says whether it worked. */
export function CopyButton({
  text,
  label = "Copy",
  ariaLabel,
  size = "sm",
}: {
  text: string;
  label?: string;
  ariaLabel?: string;
  /** `default` beside a full-size button (a dialog's Done). */
  size?: "sm" | "default";
}) {
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
    <Button type="button" variant="secondary" size={size} aria-label={ariaLabel} onClick={copy}>
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
