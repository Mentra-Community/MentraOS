/**
 * The small pieces every Licenses and Billing screen is made of, as the approved design draws them (its
 * `parts.tsx`): a notice, a fact in a card's strip, a placeholder, the ↗ button that leaves for a hosted page,
 * and the status badge. They carry no words of their own but one (the cue a screen reader gets on a button
 * that leaves the portal, from `strings/licenses.ts`): the screens pass in the rest.
 *
 * Also the pieces the seat screens share (the Members list's panel and Assign licenses): what a member is called,
 * a license Core lists with its seats, why a seat change failed, and what "Add seats ↗" needs.
 */

import { ArrowUpRightIcon, CircleCheckIcon, CreditCardIcon, TriangleAlertIcon } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";
import type { BillingAction, LicenseBilling } from "@mentra/workspace-contract/portal-billing";

import { isLicenseChangedError } from "../../errors";
import { listedAction, type JoinedLicense, type SeatCounts } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { AlertText, Badge, ErrorNotice, Spinner, type BadgeTone } from "../common";
import type { HostedAction, HostedBilling, NavigateOut } from "./hosted-action";

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
 * A button that leaves the portal for a hosted page: its arrow (↗) says so to the eye, as it must on every such
 * button, and visually hidden text says so to a screen reader ("Opens a secure billing page", or "... in a new
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
  disabled,
  "aria-describedby": describedBy,
  ...props
}: ComponentProps<typeof Button> & { pending?: boolean; newTab?: boolean }) {
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
        {pending ? <Spinner className="size-4" /> : <ArrowUpRightIcon aria-hidden="true" />}
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
 * A card whose license Core lists, so its seats are known: what the Members screens show. `joinLicenses` can also
 * return a billing entry Core hasn't received yet (no license, no seats); those are never held, and
 * `isHeldLicense` leaves them out.
 */
export type HeldLicense = JoinedLicense & { license: LicenseView; seats: SeatCounts };

/** Whether `card` is one of Core's licenses with its seats. */
export function isHeldLicense(card: JoinedLicense): card is HeldLicense {
  return card.license !== null && card.seats !== null;
}

/**
 * Why a seat change failed. A license that changed under the person (every seat taken, or gone) is "Seats changed
 * while you were choosing. Nothing was assigned." because the screen has already read the counts again; anything
 * else is the server's own words. Neutral, not amber: amber on these pages is for payments. Nothing when there is no error.
 */
export function SeatErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  if (isLicenseChangedError(error)) return <AlertText tone="neutral">{t.conflict.seatsChanged}</AlertText>;
  return <ErrorNotice error={error} tone="neutral" />;
}

/**
 * What "Add seats ↗" needs on the Members screens (the member panel and Assign licenses): the same ingredients as every
 * other ↗ button's `useHostedAction`, so it is the same way out (the tab opened in the click when billing lists
 * `returns: false`, the link when the browser blocked it, refusals in words through `HostedFeedback`). The workspace
 * `api` and the scope come from the screen itself.
 */
export interface AddSeatsSource {
  /**
   * Billing's licenses (`status.licenses`), where the viewer is offered billing. This is what decides "Add seats ↗":
   * Core shows a billing button only where billing lists the action, so a license offers it only when its entry
   * here lists `add_seats`. Without it (not offered billing, still loading, or it failed) no license offers it,
   * and the sentences drop their "add seats" half.
   */
  billing?: readonly LicenseBilling[] | null;
  /** The billing client, for the `add_seats` session. */
  billingApi: HostedBilling;
  /** The host's two ways out of the portal (`leavePortal` and `openPortalTab`). */
  navigateOut: NavigateOut;
}

/**
 * The `add_seats` action billing lists for the license, or null: the Members screens offer "Add seats ↗" only where
 * it is not null, and fail closed where billing's list is absent.
 */
export function addSeatsAction(source: Pick<AddSeatsSource, "billing">, card: Pick<JoinedLicense, "licenseId">): BillingAction | null {
  return listedAction(source.billing?.find((entry) => entry.licenseId === card.licenseId), "add_seats");
}

/** Whether the session being asked for is this license's `add_seats`: its button is the one that shows it is waiting. */
export function addingSeatsTo(hosted: Pick<HostedAction, "request">, card: Pick<JoinedLicense, "licenseId">): boolean {
  const request = hosted.request;
  return request !== null && "action" in request && request.action.kind === "add_seats" && request.licenseId === card.licenseId;
}
