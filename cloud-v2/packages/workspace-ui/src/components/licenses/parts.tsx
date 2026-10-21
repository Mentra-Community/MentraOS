/**
 * The small pieces every Licenses and Billing screen is made of, as the approved design draws them (its
 * `parts.tsx`): a notice, a fact in a card's strip, a placeholder, the ↗ button that leaves for a hosted page,
 * and the status badge. They carry no words of their own: the screens pass in sentences from
 * `strings/licenses.ts`.
 */

import { ArrowUpRightIcon, CircleCheckIcon, CreditCardIcon, TriangleAlertIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { Badge, Spinner, type BadgeTone } from "../common";

/**
 * A notice inside a card or on the page: amber (`warn`) for a failed or incomplete payment, green (`info`) for
 * good news, grey (`neutral`) for plain facts. A problem is announced (`role="alert"`); the rest are statuses.
 */
export function Notice({
  tone,
  title,
  children,
  action,
  icon,
  className,
}: {
  tone: "warn" | "info" | "neutral";
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons for what to do about it. */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const tones = {
    warn: "bg-error text-error-foreground",
    info: "bg-info text-info-foreground",
    neutral: "bg-surface text-foreground",
  } as const;
  const Icon = tone === "warn" ? TriangleAlertIcon : tone === "info" ? CircleCheckIcon : CreditCardIcon;
  return (
    <div
      role={tone === "warn" ? "alert" : "status"}
      className={cn("rounded-notice flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 text-sm", tones[tone], className)}
    >
      <span className="self-start pt-0.5">{icon ?? <Icon aria-hidden="true" className="size-[18px] shrink-0" />}</span>
      <div className="min-w-0 flex-1 basis-48 leading-5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <p className={title ? "mt-0.5" : undefined}>{children}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2 max-sm:pl-[30px]">{action}</div> : null}
    </div>
  );
}

/**
 * One fact in a card's strip: a label, a value and a line under it. It is a term and its description, for a
 * `<dl>`; on a phone the strip stacks as label · value rows. `children` sit between the value and the foot (the
 * seats' meter).
 */
export function Fact({
  label,
  value,
  foot,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-6 py-4 max-sm:px-5 max-sm:py-3">
      <div className="flex items-baseline justify-between gap-3 sm:block">
        <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
        <dd className="text-[15px] font-semibold tabular-nums sm:mt-1">{value}</dd>
      </div>
      {children}
      {foot ? <dd className="text-muted-foreground mt-1.5 text-xs max-sm:text-right">{foot}</dd> : null}
    </div>
  );
}

/** A placeholder for a value that isn't there yet (a license that is still being set up). It holds no text. */
export function Skeleton({ className = "w-24" }: { className?: string }) {
  return <span className={cn("bg-surface inline-block h-4 rounded-full align-middle", className)} />;
}

/**
 * A button that leaves the portal for a hosted page: its arrow (↗) says so, as it must on every such button.
 * It is a plain button, `data-hosted-page` marks it, and its name is its label alone (the arrow is decoration).
 * While `pending` (the session is being requested) it shows a spinner and can't be pressed again. What it does
 * on click is the caller's: ask billing for a session, then go there.
 */
export function HostedPageButton({
  children,
  pending = false,
  variant = "secondary",
  size = "sm",
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pending?: boolean }) {
  return (
    <Button
      type="button"
      data-hosted-page=""
      variant={variant}
      size={size}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {children}
      {pending ? <Spinner className="size-4" /> : <ArrowUpRightIcon aria-hidden="true" />}
    </Button>
  );
}

/** What a license's badge says: its label, its tone, and whether it spins (a license being set up). */
export interface StatusBadgeStatus {
  label: string;
  tone: BadgeTone;
  spin?: boolean;
}

/** A license's one status badge. */
export function StatusBadge({ status }: { status: StatusBadgeStatus }) {
  return (
    <Badge tone={status.tone} className="gap-1.5">
      {status.spin ? <Spinner className="size-3 border-[1.5px]" /> : null}
      {status.label}
    </Badge>
  );
}
