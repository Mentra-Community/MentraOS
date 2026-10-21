/**
 * A license's seats as the Licenses page draws them (the design's `parts.tsx` and `parts2.tsx`): who holds each
 * one, as a roster, or folded into a strip on a page with several licenses. They only draw. The card (and the
 * people picker) own the data and the requests, and pass in what to run: assigning opens the picker, Unassign
 * asks first in a dialog, and "Add licenses ↗" is there only where billing lists the action.
 */

import { ChevronDownIcon, ChevronUpIcon, CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";
import { formatDate } from "../../lib/format";
import type { SeatCounts } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { AlertText, Avatar, Count } from "../common";
import { HostedPageButton, memberLabel } from "./parts";

/** Someone who holds a seat: who they are as far as Core knows, and since when. */
export interface SeatHolder {
  membershipId: string;
  name: string | null;
  email: string | null;
  /** What to call them: `memberLabel`, from what Core knows of the member, else the user id on the seat. */
  label: string;
  /** ISO 8601. */
  assignedAt: string;
}

/**
 * The people who hold `license`'s seats, in the order Core lists them, named from the workspace's members. A
 * seat whose member isn't in `members` (the list is still loading) is shown by the user id Core has for it.
 */
export function seatHolders(license: Pick<LicenseView, "seats">, members: readonly MemberView[]): SeatHolder[] {
  const byMembership = new Map(members.map((member) => [member.membershipId, member]));
  return (license.seats ?? []).map((seat) => {
    const member = byMembership.get(seat.membershipId);
    const name = member?.name?.trim() || null;
    const email = member?.email ?? null;
    const label = memberLabel({ name, email, mentraUserId: member?.mentraUserId ?? seat.mentraUserId });
    return { membershipId: seat.membershipId, name, email, label, assignedAt: seat.assignedAt };
  });
}

/** The ↗ button for adding seats, or null where billing lists no `add_seats`: then nothing offers it. */
export interface AddSeatsControl {
  onClick(): void;
  /** The session is being requested. */
  pending?: boolean;
  /** The action doesn't return to the portal. */
  newTab?: boolean;
  disabled?: boolean;
  /**
   * Billing's refusal, and the link for a tab the browser blocked, for a surface that has to show them itself
   * (the people picker is a modal: the card behind it is out of sight). Absent where the card draws them.
   */
  error?: string | null;
  link?: string | null;
}

function AddSeatsButton({ control, variant = "secondary" }: { control: AddSeatsControl; variant?: "default" | "secondary" }) {
  return (
    <HostedPageButton variant={variant} pending={control.pending} newTab={control.newTab} disabled={control.disabled} onClick={control.onClick}>
      {t.actions.addSeats}
    </HostedPageButton>
  );
}

/** A name over an email, or the email alone where there is no name. `secondary` replaces the email line. */
export function PersonLabel({ primary, secondary }: { primary: string; secondary?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <span className="block truncate text-[15px] font-semibold">{primary}</span>
      {secondary ? <span className="text-muted-foreground block truncate text-[13px] leading-5">{secondary}</span> : null}
    </div>
  );
}

/** The holders' avatars, four of them and then "+n" for the rest. Decorative: the names are beside it. */
export function AvatarStack({ holders }: { holders: ReadonlyArray<Pick<SeatHolder, "membershipId" | "label">> }) {
  const shown = holders.slice(0, 4);
  const more = holders.length - shown.length;
  return (
    <span data-slot="avatar-stack" aria-hidden="true" className="flex items-center">
      {shown.map((holder, index) => (
        <Avatar key={holder.membershipId} label={holder.label} className={cn("ring-background size-8 text-[11px] ring-2", index > 0 && "-ml-1")} />
      ))}
      {more > 0 ? (
        <span className="bg-surface ring-background -ml-1 inline-flex size-8 items-center justify-center rounded-full border text-[11px] font-semibold ring-2">
          {t.seats.moreAvatars(more)}
        </span>
      ) : null}
    </span>
  );
}

/** What the seat controls need to know of the license and the viewer. */
interface SeatControls {
  holders: readonly SeatHolder[];
  counts: SeatCounts;
  /** The viewer may assign and unassign (`workspace.licenses.assign`). */
  canAssign: boolean;
  /** More seats are assigned than the license covers: no new assignments until it is back within the quantity. */
  blocked?: boolean;
  /** Billing's `add_seats`, or null where it lists none. */
  addSeats: AddSeatsControl | null;
  /** Opens the people picker. */
  onAssign(): void;
}

/**
 * The seats, folded: who holds them at a glance, the next action ("Assign licenses" while seats are free, "Add
 * seats ↗" when none are), and "Assigned to ⌄", which opens the roster.
 */
export function SeatStrip({
  holders,
  counts,
  canAssign,
  blocked = false,
  addSeats,
  onAssign,
  onOpen,
}: SeatControls & {
  /** Opens this license's roster. */
  onOpen(): void;
}) {
  const next =
    !canAssign || blocked ? null : counts.free > 0 ? (
      <Button variant="secondary" size="sm" onClick={onAssign}>
        <PlusIcon aria-hidden="true" />
        {t.seats.assignSeats}
      </Button>
    ) : addSeats ? (
      <AddSeatsButton control={addSeats} />
    ) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 max-sm:px-5">
      {holders.length > 0 ? <AvatarStack holders={holders} /> : null}
      <p className="min-w-0 flex-1 basis-48 text-sm font-semibold">{t.names.holders(holders.map((holder) => holder.label))}</p>
      {next ? <div className="flex flex-wrap items-center gap-2">{next}</div> : null}
      <Button variant="ghost" size="sm" className="text-muted-foreground" aria-expanded={false} onClick={onOpen}>
        {t.seats.title}
        <ChevronDownIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/** More holders than this and the roster gets a search. */
const SEARCH_FROM = 8;

/** Up to this many free seats are a row each; more fold into one. */
const FREE_ROWS_UP_TO = 3;

function FreeSeatIcon() {
  return (
    <span className="text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed">
      <PlusIcon aria-hidden="true" className="size-4" />
    </span>
  );
}

/**
 * The roster: who holds each license (their name over their email, since when, and Unassign, which asks first in a
 * dialog), then the available licenses: up to three as a row each with Assign, more folded into "<n> available
 * licenses". With every license assigned it says so and offers "Add licenses ↗" where billing lists it. With more
 * people than licenses (`blocked`) nobody can be assigned, so no assigning control shows; Unassign still does.
 *
 * Unassign opens a modal: "Unassign <name>?" with one plain line, Cancel and a destructive Unassign. Cancel, Escape, the
 * × and the backdrop close it with no request and put focus back on the row's button; a refusal is shown inside it,
 * and while the request is out it can't be dismissed.
 */
export function SeatRoster({
  holders,
  counts,
  locale,
  productName,
  canAssign,
  blocked = false,
  addSeats,
  onAssign,
  onUnassign,
  onCollapse,
}: SeatControls & {
  /** The portal's locale, for the dates. */
  locale: string;
  /** The product the licenses are for, for the line in Unassign's dialog. */
  productName: string;
  /** Takes the license back from `holder`: resolves with the refusal in words, or null once it is done. */
  onUnassign(holder: SeatHolder): Promise<string | null>;
  /** On a card that folds its licenses: the roster's title closes it again. */
  onCollapse?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [leaving, setLeaving] = useState<SeatHolder | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusTo = useRef<string | null>(null);
  // The dialog closed without taking anything back: the row's own button is where the person was.
  useEffect(() => {
    if (leaving === null && returnFocusTo.current !== null) {
      triggers.current.get(returnFocusTo.current)?.focus();
      returnFocusTo.current = null;
    }
  }, [leaving]);
  const dismiss = () => {
    if (leaving === null) return;
    returnFocusTo.current = leaving.membershipId;
    setLeaving(null);
    setRefusal(null);
  };
  const confirm = async () => {
    if (leaving === null) return;
    setPending(true);
    setRefusal(null);
    const refused = await onUnassign(leaving);
    setPending(false);
    // Done: the row is on its way out, so there is nothing to give focus back to.
    if (refused === null) setLeaving(null);
    else setRefusal(refused);
  };
  const searchable = holders.length > SEARCH_FROM;
  const needle = query.trim().toLowerCase();
  const shown =
    searchable && needle
      ? holders.filter((holder) => `${holder.name ?? ""} ${holder.email ?? ""} ${holder.label}`.toLowerCase().includes(needle))
      : holders;
  const assignable = canAssign && !blocked;
  const searching = searchable && needle !== "";
  const title = (
    <>
      {t.seats.title}
      <Count>{holders.length}</Count>
    </>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold">
          {onCollapse ? (
            <button type="button" aria-expanded={true} onClick={onCollapse} className="flex cursor-pointer items-center gap-2 font-semibold">
              {title}
              <ChevronUpIcon aria-hidden="true" className="text-muted-foreground size-4" />
            </button>
          ) : (
            <span className="flex items-center gap-2">{title}</span>
          )}
        </h3>
        {assignable && counts.free > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {addSeats ? <AddSeatsButton control={addSeats} /> : null}
            <Button size="sm" onClick={onAssign}>
              <PlusIcon aria-hidden="true" />
              {t.seats.assignSeats}
            </Button>
          </div>
        ) : null}
      </div>
      {searchable ? (
        <div className="relative">
          <SearchIcon aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.seats.searchPlaceholder}
            aria-label={t.seats.searchPlaceholder}
            className="h-10 pl-11 text-[15px]"
          />
        </div>
      ) : null}
      <ul className="divide-y overflow-hidden rounded-[16px] border">
        {shown.map((holder) => (
          <li key={holder.membershipId} className="flex items-center gap-3 px-4 py-3">
            <Avatar label={holder.label} />
            <PersonLabel primary={holder.label} secondary={holder.name ? holder.email : undefined} />
            <span className="text-muted-foreground hidden text-sm whitespace-nowrap sm:block">
              {t.seats.since(formatDate(holder.assignedAt, locale))}
            </span>
            {canAssign ? (
              <Button
                ref={(button) => {
                  if (button) triggers.current.set(holder.membershipId, button);
                  else triggers.current.delete(holder.membershipId);
                }}
                type="button"
                variant="destructive-secondary"
                size="sm"
                aria-label={t.seats.unassignAria(holder.label)}
                onClick={() => setLeaving(holder)}
              >
                {t.seats.unassign}
              </Button>
            ) : null}
          </li>
        ))}
        {searching && shown.length === 0 ? (
          <li className="text-muted-foreground px-4 py-3 text-sm">{t.picker.noMatches}</li>
        ) : null}
        {!searching && assignable && counts.free > 0 && counts.free <= FREE_ROWS_UP_TO
          ? Array.from({ length: counts.free }, (_, index) => (
              <li key={`free-${index}`} className="flex items-center gap-3 px-4 py-3">
                <FreeSeatIcon />
                <span className="text-muted-foreground flex-1 text-[15px]">{t.seats.freeSeat}</span>
                <Button variant="secondary" size="sm" onClick={onAssign}>
                  {t.seats.assign}
                </Button>
              </li>
            ))
          : null}
        {!searching && counts.free > FREE_ROWS_UP_TO ? (
          <li className="flex items-center gap-3 px-4 py-3">
            <FreeSeatIcon />
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">{t.seats.freeSeats(counts.free)}</div>
              {holders.length === 0 ? <div className="text-muted-foreground text-[13px] leading-5">{t.seats.nobodyYet}</div> : null}
            </div>
          </li>
        ) : null}
        {!searching && assignable && counts.free === 0 ? (
          <li className="bg-surface/70 flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5">
            <span className="bg-background flex size-9 shrink-0 items-center justify-center rounded-full border">
              <CheckIcon aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0 flex-1 basis-56 text-sm leading-5">
              <p className="font-semibold">{t.seats.allInUse(counts.quantity)}</p>
              <p className="text-muted-foreground">{t.seats.allInUseHelp(addSeats !== null)}</p>
            </div>
            {addSeats ? <AddSeatsButton control={addSeats} variant="default" /> : null}
          </li>
        ) : null}
      </ul>
      {/* Mounted only while it asks, so a roster holds no dialog of its own until then. */}
      {leaving ? (
        <Dialog
          open
          onClose={dismiss}
          locked={pending}
          title={t.seats.unassignPrompt(leaving.label)}
          description={t.seats.unassignBody(leaving.label, productName)}
        >
          {refusal !== null ? <AlertText tone="neutral">{refusal}</AlertText> : null}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="button" variant="secondary" disabled={pending} onClick={dismiss}>
              {t.seats.cancel}
            </Button>
            <Button type="button" variant="destructive" disabled={pending} aria-busy={pending || undefined} onClick={() => void confirm()}>
              {t.seats.unassign}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
