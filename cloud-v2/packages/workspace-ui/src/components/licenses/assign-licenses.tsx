/**
 * Assign licenses: the people chosen in the Members list, one row per license the workspace holds, one request.
 *
 * Each row says what fits, checked against the seats free before anything is confirmed (`fitFor` and
 * `licenseStrings.fit.line`, which hold the spec's five sentences). A row that fits starts checked; one that
 * doesn't ("2 of 3 fit: remove one or add seats.", "All 10 seats are in use.", "Everyone you chose has one.") can't
 * be checked, and where adding seats would help it has "Add seats ↗". The footer counts the seats per product and
 * "Assign <n> seats" sends every checked row in one `assignSeats` request, which Core assigns all or nothing. When
 * seats changed meanwhile (a 409) nothing was assigned: the counts are read again and the dialog says so, and a row
 * that no longer fits unchecks itself.
 *
 * One request takes at most `MAX_SEAT_ASSIGNMENTS` pairs. Beyond that Assign stays off, with "You can assign up to
 * 500 seats at a time." under it.
 *
 * It is a seat mutation (`useSeatMutation`), so billing's status for the workspace is read again too. The body
 * renders only while the dialog is open, so each opening starts fresh. This file imports no runtime code from the
 * contract's billing schemas.
 */

import { MAX_SEAT_ASSIGNMENTS, type MemberView } from "@mentra/workspace-contract";
import { useId, useState } from "react";
import type { WorkspaceApi } from "../../api";
import { fitFor } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { useSeatMutation } from "../../queries";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Dialog } from "../../ui/dialog";
import { AlertText } from "../common";
import { HostedPageButton, memberLabel, SeatErrorNotice, useAddSeats, type HeldLicense } from "./parts";
import { ProductIcon } from "./product";

export interface AssignLicensesDialogProps {
  open: boolean;
  /** The person asked to close it, or the seats were assigned. */
  onClose(): void;
  api: WorkspaceApi;
  workspaceId: string;
  /** The members chosen who can be given a seat (they have signed in), in the order to name them. */
  people: readonly MemberView[];
  /** The licenses the workspace holds, in the order to show them. */
  cards: readonly HeldLicense[];
  /** Whether "Add seats ↗" is offered for the license: billing lists `add_seats` for it and the host can start it. */
  canAddSeats(card: HeldLicense): boolean;
  onAddSeats?(licenseId: string): unknown;
  /** Every checked seat was assigned. */
  onAssigned(): void;
}

/** The dialog. See the file's note. */
export function AssignLicensesDialog({ open, onClose, people, ...body }: AssignLicensesDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={t.assign.title} description={t.names.list(people.map(memberLabel))} className="max-w-[560px]">
      <AssignBody people={people} onClose={onClose} {...body} />
    </Dialog>
  );
}

function AssignBody({
  onClose,
  api,
  workspaceId,
  people,
  cards,
  canAddSeats,
  onAddSeats,
  onAssigned,
}: Omit<AssignLicensesDialogProps, "open">) {
  // What the person turned off. A row is checked when it fits and wasn't turned off, so one that stops fitting
  // (the counts were read again) unchecks itself, and one that fits again goes back on.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const assign = useSeatMutation(api, workspaceId, (pairs: { licenseId: string; membershipId: string }[]) => api.assignSeats(workspaceId, pairs));
  const add = useAddSeats(onAddSeats);

  const rows = cards.map((card) => {
    const fit = fitFor(card.license, people);
    return { card, fit, checked: fit.ok && !unchecked.has(card.licenseId) };
  });
  const chosen = rows.filter((row) => row.checked);
  const pairs = chosen.flatMap(({ card, fit }) => fit.recipients.map((person) => ({ licenseId: card.licenseId, membershipId: person.membershipId })));
  const seats = chosen.map(({ card, fit }) => ({ seats: fit.needed, name: card.shortName }));
  // One request takes at most MAX_SEAT_ASSIGNMENTS pairs: beyond that Assign stays off, and says why.
  const tooMany = pairs.length > MAX_SEAT_ASSIGNMENTS;
  const tooManyId = useId();

  return (
    <>
      <ul className="space-y-2">
        {rows.map(({ card, fit, checked }) => (
          <AssignRow
            key={card.licenseId}
            card={card}
            note={t.fit.line(fit, { nameOf: memberLabel, canAddSeats: canAddSeats(card) })}
            checked={checked}
            blocked={!fit.ok}
            // Adding seats helps when there aren't enough, not when everyone chosen already has one.
            addSeats={(fit.kind === "short" || fit.kind === "full") && canAddSeats(card)}
            addPending={add.pending === card.licenseId}
            disabled={assign.isPending}
            onToggle={(on) =>
              setUnchecked((current) => {
                const next = new Set(current);
                if (on) next.delete(card.licenseId);
                else next.add(card.licenseId);
                return next;
              })
            }
            onAddSeats={() => add.run(card)}
          />
        ))}
      </ul>
      <SeatErrorNotice error={assign.error} />
      {add.message ? <AlertText>{add.message}</AlertText> : null}
      <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4 sm:-mx-7 sm:-mb-7 sm:px-7">
        <span data-slot="assign-footer" className="text-muted-foreground text-sm">
          {t.assign.footer(seats)}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t.picker.cancel}
          </Button>
          <Button
            type="button"
            disabled={pairs.length === 0 || tooMany || assign.isPending}
            aria-describedby={tooMany ? tooManyId : undefined}
            onClick={() => assign.mutate(pairs, { onSuccess: onAssigned })}
          >
            {t.assign.confirm(chosen.reduce((sum, row) => sum + row.fit.needed, 0))}
          </Button>
        </div>
        {tooMany ? (
          <p id={tooManyId} className="text-muted-foreground basis-full text-right text-sm">
            {t.assign.tooMany(MAX_SEAT_ASSIGNMENTS)}
          </p>
        ) : null}
      </div>
    </>
  );
}

/** One license: a checkbox that spans the row, its icon and name, what fits, and Add seats where it would help. */
function AssignRow({
  card,
  note,
  checked,
  blocked,
  addSeats,
  addPending,
  disabled,
  onToggle,
  onAddSeats,
}: {
  card: HeldLicense;
  note: string | null;
  checked: boolean;
  blocked: boolean;
  addSeats: boolean;
  addPending: boolean;
  disabled: boolean;
  onToggle(on: boolean): void;
  onAddSeats(): void;
}) {
  const nameId = useId();
  const noteId = useId();
  return (
    <li>
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] border p-3", checked && "bg-hover border-transparent")}>
        <label className={cn("flex min-w-0 flex-1 basis-56 items-center gap-3", blocked || disabled ? "cursor-not-allowed" : "cursor-pointer")}>
          <Checkbox
            checked={checked}
            disabled={blocked || disabled}
            aria-labelledby={nameId}
            aria-describedby={note ? noteId : undefined}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span className={cn("flex min-w-0 flex-1 items-center gap-3", blocked && "opacity-50")}>
            <ProductIcon product={card} size={36} />
            <span className="min-w-0">
              <span id={nameId} data-slot="license-name" className="block text-[15px] font-semibold">
                {card.name}
              </span>
              {note ? (
                <span id={noteId} className="text-muted-foreground block text-[13px] leading-5">
                  {note}
                </span>
              ) : null}
            </span>
          </span>
        </label>
        {addSeats ? (
          <HostedPageButton pending={addPending} onClick={onAddSeats}>
            {t.actions.addSeats}
          </HostedPageButton>
        ) : null}
      </div>
    </li>
  );
}
