/**
 * A license's seats as the Licenses page draws them (the design's `parts.tsx` and `parts2.tsx`): who holds each
 * one, as a roster, or folded into a strip on a page with several licenses. They only draw. The card (and the
 * people picker) own the data and the requests, and pass in what to run: assigning opens the picker, Unassign
 * asks first in a dialog, and "Buy subscriptions ↗" is there only where billing lists the action.
 */

import { ChevronDownIcon, ChevronUpIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";
import { formatDate } from "../../lib/format";
import { cn } from "../../lib/utils";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Avatar, Count } from "../common";
import { ConfirmDialog } from "../confirm-dialog";
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

function AddSeatsButton({ control }: { control: AddSeatsControl }) {
  return (
    <HostedPageButton variant="secondary" pending={control.pending} newTab={control.newTab} disabled={control.disabled} onClick={control.onClick}>
      {t.actions.addSeats}
    </HostedPageButton>
  );
}

/**
 * What a viewer who may assign can do about the seats, whatever is assigned: "Buy subscriptions ↗" where billing lists
 * it, and "Assign subscriptions" unless more are assigned than paid for (`blocked`). Null for anyone else.
 */
function SeatActions({ canAssign, blocked, addSeats, onAssign, primary }: Pick<SeatControls, "canAssign" | "blocked" | "addSeats" | "onAssign"> & { primary: boolean }) {
  if (!canAssign || (blocked && addSeats === null)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {addSeats ? <AddSeatsButton control={addSeats} /> : null}
      {blocked ? null : (
        <Button variant={primary ? "default" : "secondary"} size="sm" onClick={onAssign}>
          <PlusIcon aria-hidden="true" />
          {t.seats.assignSeats}
        </Button>
      )}
    </div>
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
 * The seats, folded: who holds them at a glance, the seat actions ({@link SeatActions}), and "Assigned to ⌄", which
 * opens the roster.
 */
export function SeatStrip({
  holders,
  canAssign,
  blocked = false,
  addSeats,
  onAssign,
  onOpen,
}: SeatControls & {
  /** Opens this license's roster. */
  onOpen(): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 max-sm:px-5">
      {holders.length > 0 ? <AvatarStack holders={holders} /> : null}
      <p className="min-w-0 flex-1 basis-48 text-sm font-semibold">{t.names.holders(holders.map((holder) => holder.label))}</p>
      <SeatActions canAssign={canAssign} blocked={blocked} addSeats={addSeats} onAssign={onAssign} primary={false} />
      <Button variant="ghost" size="sm" className="text-muted-foreground" aria-expanded={false} onClick={onOpen}>
        {t.seats.title}
        <ChevronDownIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/** More holders than this and the roster gets a search. */
const SEARCH_FROM = 8;

/**
 * The roster: the seat actions ({@link SeatActions}) beside its title, whatever is assigned, then who holds each
 * subscription (their name over their email, since when, and Unassign, which asks first in a dialog). Seats nobody
 * holds have no rows: the Subscriptions fact counts them. With more people than subscriptions (`blocked`) nobody can
 * be assigned, so no assigning control shows; Unassign still does.
 *
 * Unassign opens a modal: "Unassign <name>?" with one plain line, Cancel and a destructive Unassign. Cancel, Escape, the
 * × and the backdrop close it with no request and put focus back on the row's button; a refusal is shown inside it,
 * and while the request is out it can't be dismissed. Once the license is taken back its row is on its way out, so
 * focus goes to the next row's Unassign button (the previous row's if it was the last), or to the roster's heading
 * when no row is left.
 */
export function SeatRoster({
  holders,
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
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  // Whose Unassign button gets focus when the dialog is gone, or null for the heading.
  const returnFocusTo = useRef<{ membershipId: string | null } | null>(null);
  // Where focus goes if the license is taken back, worked out when the dialog opens from the rows then on the screen.
  const afterTakingBack = useRef<string | null>(null);
  useEffect(() => {
    if (leaving === null && returnFocusTo.current !== null) {
      const { membershipId } = returnFocusTo.current;
      returnFocusTo.current = null;
      (membershipId === null ? heading.current : (triggers.current.get(membershipId) ?? heading.current))?.focus();
    }
  }, [leaving]);
  // Backed out: the button that asked. Done: its row is on its way out, so the neighbour's button (or the heading).
  const closeDialog = (done: boolean) => {
    if (leaving === null) return;
    returnFocusTo.current = { membershipId: done ? afterTakingBack.current : leaving.membershipId };
    setLeaving(null);
  };
  const searchable = holders.length > SEARCH_FROM;
  const needle = query.trim().toLowerCase();
  const shown =
    searchable && needle
      ? holders.filter((holder) => `${holder.name ?? ""} ${holder.email ?? ""} ${holder.label}`.toLowerCase().includes(needle))
      : holders;
  const askToUnassign = (holder: SeatHolder) => {
    const at = shown.findIndex((candidate) => candidate.membershipId === holder.membershipId);
    afterTakingBack.current = (shown[at + 1] ?? shown[at - 1])?.membershipId ?? null;
    setLeaving(holder);
  };
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
        <h3 ref={heading} tabIndex={-1} className="text-[15px] font-semibold">
          {onCollapse ? (
            <button type="button" aria-expanded={true} onClick={onCollapse} className="flex cursor-pointer items-center gap-2 font-semibold">
              {title}
              <ChevronUpIcon aria-hidden="true" className="text-muted-foreground size-4" />
            </button>
          ) : (
            <span className="flex items-center gap-2">{title}</span>
          )}
        </h3>
        <SeatActions canAssign={canAssign} blocked={blocked} addSeats={addSeats} onAssign={onAssign} primary={true} />
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
      {/* With nobody to list there is no list: the title's count says so. */}
      {shown.length === 0 && !searching ? null : (
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
                  onClick={() => askToUnassign(holder)}
                >
                  {t.seats.unassign}
                </Button>
              ) : null}
            </li>
          ))}
          {searching && shown.length === 0 ? (
            <li className="text-muted-foreground px-4 py-3 text-sm">{t.picker.noMatches}</li>
          ) : null}
        </ul>
      )}
      {/* Mounted only while it asks, so a roster holds no dialog of its own until then. */}
      {leaving ? (
        <ConfirmDialog
          title={t.seats.unassignPrompt(leaving.label)}
          description={t.seats.unassignBody(leaving.label, productName)}
          cancelLabel={t.seats.cancel}
          confirmLabel={t.seats.unassign}
          onConfirm={() => onUnassign(leaving)}
          onClose={closeDialog}
        />
      ) : null}
    </div>
  );
}
