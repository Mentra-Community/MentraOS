/**
 * The small pieces every Licenses and Billing screen is made of, as the approved design draws them (its
 * `parts.tsx`): a notice, a fact in a card's strip, a placeholder, the ↗ button that leaves for a hosted page,
 * and the status badge. They carry no words of their own but one (the cue a screen reader gets on a button
 * that leaves the portal, from `strings/licenses.ts`): the screens pass in the rest.
 *
 * Also the pieces the seat screens share (the Members list and the people picker): what a member is called,
 * a license Core lists with its seats, and why a seat change failed.
 */

import { ArrowUpRightIcon, CircleCheckIcon, CreditCardIcon, TriangleAlertIcon } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";

import { isLicenseChangedError } from "../../errors";
import type { JoinedLicense, SeatCounts } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { AlertText, Badge, ErrorNotice, Spinner, type BadgeTone } from "../common";

/**
 * A notice inside a card or on the page: amber (`warn`) for a failed or incomplete payment, green (`info`) for
 * good news, grey (`neutral`) for plain facts. Every tone is a status (`role="status"`), not an alert: they are
 * part of the page, several can be on it at once, and none interrupts the person.
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
      role="status"
      className={cn("rounded-notice flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 text-sm", tones[tone], className)}
    >
      <span className="self-start pt-0.5">{icon ?? <Icon aria-hidden="true" className="size-[18px] shrink-0" />}</span>
      <div className="min-w-0 flex-1 basis-48 leading-5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <p className={title ? "mt-0.5" : undefined}>{children}</p> : null}
      </div>
      {/* On a phone the buttons take a row of their own, under the text and in line with it, and wrap there. */}
      {action ? <div className="flex flex-wrap gap-2 max-sm:basis-full max-sm:pl-[30px] sm:shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * One fact in a card's strip: a label, a value and a line under it. It is one group of a `<dl>`: the outer
 * `div` holds the term (`dt`) and its descriptions (`dd`: the value, `children`, the foot) as its direct
 * children, which is how HTML allows a group in a description list. Laid out as a grid so that on a phone the
 * strip stacks as label · value rows, with `children` (the seats' meter) and the foot under them.
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
    <div className="grid min-w-0 grid-cols-[auto_1fr] items-baseline gap-x-3 px-6 py-4 max-sm:px-5 max-sm:py-3 sm:block">
      <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
      <dd className="text-[15px] font-semibold tabular-nums max-sm:text-right sm:mt-1">{value}</dd>
      {children ? <dd className="col-span-2">{children}</dd> : null}
      {foot ? <dd className="text-muted-foreground col-span-2 mt-1.5 text-xs max-sm:text-right">{foot}</dd> : null}
    </div>
  );
}

/** A placeholder for a value that isn't there yet (a license that is still being set up). It holds no text. */
export function Skeleton({ className = "w-24" }: { className?: string }) {
  return <span className={cn("bg-surface inline-block h-4 rounded-full align-middle", className)} />;
}

/**
 * A button that leaves the portal for a hosted page: its arrow (↗) says so to the eye (unless `arrow` is false: the
 * header's Billing and Buy more seats go without), and visually hidden text says so to a screen reader ("Opens a secure billing page", or "... in a new
 * tab" with `newTab`, for an action listed with `returns: false`). The text is the button's description, not
 * part of it: the button's name and `textContent` stay its label alone. `data-hosted-page` marks it.
 *
 * While `pending` (the session is being requested) it shows a spinner and can't be pressed again. What it does
 * on click is the caller's: ask billing for a session, then go there.
 */
export function HostedPageButton({
  children,
  pending = false,
  newTab = false,
  variant = "secondary",
  size = "sm",
  arrow = true,
  disabled,
  "aria-describedby": describedBy,
  ...props
}: ComponentProps<typeof Button> & { pending?: boolean; newTab?: boolean; arrow?: boolean }) {
  const hint = useId();
  return (
    <>
      <Button
        type="button"
        data-hosted-page=""
        variant={variant}
        size={size}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        aria-describedby={describedBy ? `${describedBy} ${hint}` : hint}
        {...props}
      >
        {children}
        {pending ? <Spinner className="size-4" /> : arrow ? <ArrowUpRightIcon aria-hidden="true" /> : null}
      </Button>
      <span id={hint} className="sr-only">
        {newTab ? t.actions.opensSecureBillingPageInNewTab : t.actions.opensSecureBillingPage}
      </span>
    </>
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

/** What a member is called: their name, else their email, else their Mentra user id, else "Imported member". */
export function memberLabel(member: Pick<MemberView, "name" | "email" | "mentraUserId">): string {
  return member.name?.trim() || member.email || member.mentraUserId || t.members.importedMember;
}

/**
 * A card whose license Core lists, so its seats are known: what the Members list shows. `joinLicenses` can also
 * return a billing entry Core hasn't received yet (no license, no seats); those are never held, and
 * `isHeldLicense` leaves them out.
 */
export type HeldLicense = JoinedLicense & { license: LicenseView; seats: SeatCounts };

/** Whether `card` is one of Core's licenses with its seats. */
export function isHeldLicense(card: JoinedLicense): card is HeldLicense {
  return card.license !== null && card.seats !== null;
}

/**
 * Why a seat change failed. A license that changed under the person (every seat taken, or gone) is "Licenses changed
 * while you were choosing. Nothing was assigned." because the screen has already read the counts again; anything
 * else is the server's own words. Neutral, not amber: amber on these pages is for payments. Nothing when there is no error.
 */
export function SeatErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  if (isLicenseChangedError(error)) return <AlertText tone="neutral">{t.conflict.seatsChanged}</AlertText>;
  return <ErrorNotice error={error} tone="neutral" />;
}
