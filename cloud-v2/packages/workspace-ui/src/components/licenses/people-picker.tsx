/**
 * "Assign seats": a dialog that searches the workspace's members, chooses several, and gives them all a seat of
 * one license in one request, all or none. People who already hold a seat, or haven't signed in yet, are listed
 * but can't be chosen, with the reason. Nothing caps the choice: when more are chosen than there are seats, the
 * dialog says how many fit ("3 of 4 fit: remove one or add seats.") and Assign stays off, so the person decides
 * between fewer people and more seats.
 *
 * It asks Core for the assignment only; the counts it shows come from the license it is given, which the host
 * keeps fresh. A request that loses a race (409 `no_seats_available`) assigns nothing, refetches, and says so.
 */

import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";
import type { WorkspaceApi } from "../../api";
import { errorMessage, isLicenseChangedError } from "../../errors";
import { fitFor, holdsSeat, seatCounts } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { useSeatMutation } from "../../queries";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Dialog } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { AlertText, Avatar } from "../common";
import { HostedFeedback } from "./hosted-action";
import { HostedPageButton, Notice } from "./parts";
import { PersonLabel, type AddSeatsControl } from "./seats";

/** Why a member can't be chosen, or null when they can. */
type Why = "holds" | "pending" | null;

function whyNot(license: Pick<LicenseView, "seats">, member: MemberView): Why {
  if (holdsSeat(license, member.membershipId)) return "holds";
  return member.pending || member.mentraUserId === null ? "pending" : null;
}

const labelOf = (member: MemberView) => member.name?.trim() || member.email || member.mentraUserId || t.members.importedMember;

export function PeoplePickerDialog({
  open,
  onClose,
  api,
  workspaceId,
  license,
  productName,
  members,
  addSeats,
}: {
  open: boolean;
  onClose(): void;
  api: WorkspaceApi;
  workspaceId: string;
  /** The license the seats are of, as Core last listed it. */
  license: LicenseView;
  productName: string;
  members: readonly MemberView[];
  /** "Add seats ↗", or null where billing lists no `add_seats`: then the dialog offers only fewer people. */
  addSeats: AddSeatsControl | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t.picker.title}
      description={t.picker.description(productName, seatCounts(license).free)}
      className="max-w-[520px]"
    >
      <PickerBody api={api} workspaceId={workspaceId} license={license} members={members} addSeats={addSeats} onClose={onClose} />
    </Dialog>
  );
}

/** The dialog's content, which exists only while it is open, so a choice never outlives it. */
function PickerBody({
  api,
  workspaceId,
  license,
  members,
  addSeats,
  onClose,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  license: LicenseView;
  members: readonly MemberView[];
  addSeats: AddSeatsControl | null;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const assign = useSeatMutation(api, workspaceId, (assignments: Array<{ licenseId: string; membershipId: string }>) =>
    api.assignSeats(workspaceId, assignments),
  );

  // Who can be chosen first, then who hasn't signed in, then who has a seat: by name within each.
  const rows = useMemo(() => {
    const order: Record<NonNullable<Why> | "open", number> = { open: 0, pending: 1, holds: 2 };
    return members
      .map((member) => ({ member, why: whyNot(license, member), label: labelOf(member) }))
      .sort((a, b) => order[a.why ?? "open"] - order[b.why ?? "open"] || a.label.localeCompare(b.label));
  }, [members, license]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter(({ member }) => `${member.name ?? ""} ${member.email ?? ""}`.toLowerCase().includes(needle))
    : rows;

  // Only people who can still be given a seat count, whatever was ticked before the list changed.
  const people = rows.filter((row) => row.why === null && chosen.has(row.member.membershipId)).map((row) => row.member);
  const fit = fitFor(license, people);
  const counts = seatCounts(license);
  const overflow = fit.kind === "short" || fit.kind === "full";
  const failure = assign.error;

  function toggle(membershipId: string, on: boolean) {
    assign.reset();
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(membershipId);
      else next.delete(membershipId);
      return next;
    });
  }

  return (
    <>
      <div className="space-y-4">
        <div className="relative">
          <SearchIcon aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.picker.search}
            aria-label={t.picker.search}
            className="pl-11"
          />
        </div>
        {overflow ? (
          <Notice
            tone="neutral"
            title={t.fit.line(fit, { nameOf: labelOf, canAddSeats: addSeats !== null })}
            action={
              addSeats ? (
                <HostedPageButton pending={addSeats.pending} newTab={addSeats.newTab} disabled={addSeats.disabled} onClick={addSeats.onClick}>
                  {t.actions.addSeats}
                </HostedPageButton>
              ) : undefined
            }
          />
        ) : null}
        {/* Add seats leaves for billing: when that fails, the person is told here, where they are looking. */}
        <HostedFeedback action={{ error: addSeats?.error ?? null, link: addSeats?.link ?? null }} />
        {failure ? <AlertText>{isLicenseChangedError(failure) ? t.conflict.seatsChanged : errorMessage(failure)}</AlertText> : null}
        <ul className="-mx-2 max-h-[min(46vh,400px)] space-y-0.5 overflow-y-auto">
          {visible.map(({ member, why, label }) => {
            const off = why !== null || assign.isPending;
            const on = chosen.has(member.membershipId) && why === null;
            return (
              <li key={member.membershipId}>
                <label
                  className={cn(
                    "flex items-center gap-3 rounded-[14px] px-2 py-2",
                    !off && "hover:bg-hover cursor-pointer",
                    on && "bg-hover",
                    off && "cursor-not-allowed",
                  )}
                >
                  <Checkbox checked={on} disabled={off} onChange={(event) => toggle(member.membershipId, event.target.checked)} />
                  <span className={cn("flex min-w-0 flex-1 items-center gap-3", why !== null && "opacity-50")}>
                    <Avatar label={label} />
                    <PersonLabel primary={label} secondary={member.name?.trim() ? member.email : undefined} />
                  </span>
                  {why !== null ? (
                    <span className="text-muted-foreground shrink-0 text-xs font-semibold">
                      {why === "holds" ? t.picker.hasASeat : t.picker.afterFirstSignIn}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
          {visible.length === 0 ? <li className="text-muted-foreground px-2 py-2 text-sm">{t.picker.noMatches}</li> : null}
        </ul>
      </div>
      <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4 sm:-mx-7 sm:-mb-7 sm:px-7">
        <span className="text-muted-foreground text-sm">{t.picker.chosen(people.length, counts.free)}</span>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t.picker.cancel}
          </Button>
          <Button
            type="button"
            disabled={!fit.ok || assign.isPending}
            aria-busy={assign.isPending || undefined}
            onClick={() =>
              assign.mutate(
                people.map((member) => ({ licenseId: license.licenseId, membershipId: member.membershipId })),
                { onSuccess: onClose },
              )
            }
          >
            {t.picker.assign(people.length)}
          </Button>
        </div>
      </div>
    </>
  );
}
