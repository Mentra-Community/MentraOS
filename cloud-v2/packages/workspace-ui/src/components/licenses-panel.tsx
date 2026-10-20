/**
 * The workspace's licenses and who holds their seats.
 *
 * What the viewer sees follows Core's answer, which follows their capabilities. An Admin or Owner
 * (`workspace.licenses.read`) sees every license with how many seats are used of how many, who holds each
 * seat, and can assign a seat to a member who has none and unassign one. Everyone else is listed only the
 * licenses they hold a seat in, each with only their own seat: they see that they hold it and until when,
 * and nothing about anyone else, no totals and no control. Controls the viewer's role cannot use are left
 * out, not greyed out; Core refuses them anyway.
 *
 * A license can hold more seats than its quantity: lowering the quantity frees no seat. Its notice says how
 * many to unassign, and the license takes no new seat until it is back within its quantity.
 *
 * A member who is waiting for their first sign-in (imported from the Store) has no Mentra user id yet and
 * cannot be given a seat, so they are not offered one.
 */

import { useQuery } from "@tanstack/react-query";
import type { LicenseSeatView, LicenseView, MemberView } from "@mentra/workspace-contract";
import { Info } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { WorkspaceApi } from "../api";
import { formatDate } from "../lib/format";
import { licensesQuery, membersQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can } from "../roles";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Avatar, ConfirmButton, ErrorNotice, Panel, QueryGate, Restricted } from "./common";

/** How the products Mentra sells are named to people. A product this does not know is shown by its id. */
const PRODUCT_LABELS: Record<string, string> = {
  "mentra.call.unlimited": "Mentra Call Unlimited",
};

/** The product as a person reads it. */
export function productLabel(product: string): string {
  return PRODUCT_LABELS[product] ?? product;
}

/** The two seat changes, as functions of one change each: what the panel's mutations run. */
export function seatChanges(api: WorkspaceApi, workspaceId: string) {
  return {
    assign: (change: { licenseId: string; membershipId: string }) =>
      api.assignSeat(workspaceId, change.licenseId, change.membershipId),
    release: (change: { licenseId: string; membershipId: string }) =>
      api.releaseSeat(workspaceId, change.licenseId, change.membershipId),
  };
}

/** The members a seat of `license` can be given to: those who hold none of it and have signed in. */
export function unseatedMembers(license: Pick<LicenseView, "seats">, members: readonly MemberView[]): MemberView[] {
  const seated = new Set((license.seats ?? []).map((seat) => seat.membershipId));
  return members.filter((member) => !seated.has(member.membershipId) && !member.pending);
}

const memberLabel = (member: MemberView) => member.email ?? member.mentraUserId ?? "Imported member";
const seatWord = (count: number) => (count === 1 ? "seat" : "seats");

/** Where the license's term stands: not started, in term (paid through), or past it. */
function termText(license: Pick<LicenseView, "validFrom" | "paidThrough">, now: number): string {
  if (Date.parse(license.validFrom) > now) return `Starts ${formatDate(license.validFrom)}`;
  if (Date.parse(license.paidThrough) <= now) return `Expired ${formatDate(license.paidThrough)}`;
  return `Paid through ${formatDate(license.paidThrough)}`;
}

export function WorkspaceLicensesPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const licensesResult = useQuery(licensesQuery(api, workspaceId));
  const reads = can(detailResult.data, "workspace.licenses.read");
  // Who the seats can go to, and who holds them by name. Only those who see every seat need the members.
  const membersResult = useQuery({ ...membersQuery(api, workspaceId), enabled: reads });

  const seats = seatChanges(api, workspaceId);
  const assign = useWorkspaceMutation(api, workspaceId, seats.assign);
  const release = useWorkspaceMutation(api, workspaceId, seats.release);

  const description = detailResult.data
    ? reads
      ? "What this workspace has bought, and who holds each seat."
      : "The licenses you hold a seat in."
    : undefined;

  return (
    <Panel title="Licenses" count={licensesResult.data?.length} description={description}>
      <QueryGate result={detailResult}>
        {(detail) => (
          <QueryGate result={licensesResult}>
            {(licenses) =>
              can(detail, "workspace.licenses.read") ? (
                licenses.length === 0 ? (
                  <Restricted>This workspace has no licenses yet.</Restricted>
                ) : (
                  <QueryGate result={membersResult}>
                    {(members) => (
                      <div className="space-y-4">
                        {licenses.map((license) => (
                          <LicenseCard
                            key={license.licenseId}
                            license={license}
                            members={members}
                            busy={assign.isPending || release.isPending}
                            onAssign={(licenseId, membershipId) => {
                              release.reset();
                              assign.mutate({ licenseId, membershipId });
                            }}
                            onRelease={(licenseId, membershipId) => {
                              assign.reset();
                              release.mutate({ licenseId, membershipId });
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </QueryGate>
                )
              ) : (
                <OwnSeats licenses={licenses} />
              )
            }
          </QueryGate>
        )}
      </QueryGate>
      <ErrorNotice error={assign.error ?? release.error} />
    </Panel>
  );
}

const CARD = "rounded-notice space-y-4 border p-4";

/**
 * A member's view: the licenses they hold a seat in, each with that they hold it and its term. Core lists
 * them only the licenses with a seat of theirs; one without a seat is left out rather than claimed.
 */
function OwnSeats({ licenses }: { licenses: readonly LicenseView[] }) {
  const held = licenses.filter((license) => (license.seats?.length ?? 0) > 0);
  if (held.length === 0) return <Restricted>You do not hold a seat in a license of this workspace yet.</Restricted>;
  return (
    <div className="space-y-4">
      {held.map((license) => (
        <article key={license.licenseId} aria-label={productLabel(license.product)} className={CARD}>
          <h3 className="text-base font-semibold">{productLabel(license.product)}</h3>
          <p className="text-sm font-semibold">You hold a seat</p>
          <p className="text-muted-foreground text-sm">{termText(license, Date.now())}</p>
        </article>
      ))}
    </div>
  );
}

/** An Admin's view of a license: its seats used and total, the notice if it is over, who holds each seat, and assigning another. */
function LicenseCard({
  license,
  members,
  busy,
  onAssign,
  onRelease,
}: {
  license: LicenseView;
  members: readonly MemberView[];
  busy: boolean;
  onAssign(licenseId: string, membershipId: string): void;
  onRelease(licenseId: string, membershipId: string): void;
}) {
  const label = productLabel(license.product);
  const over = license.seatsUsed - license.quantity;
  const candidates = unseatedMembers(license, members);
  const holders = license.seats ?? [];

  return (
    <article aria-label={label} className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{label}</h3>
          <p className="text-muted-foreground text-sm">{termText(license, Date.now())}</p>
        </div>
        <p className="text-sm font-semibold tabular-nums">
          {`${license.seatsUsed} of ${license.quantity} ${seatWord(license.quantity)} used`}
        </p>
      </div>

      {over > 0 ? (
        <p role="note" className="rounded-notice bg-info text-info-foreground flex items-start gap-2.5 px-4 py-3 text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {`This license covers ${license.quantity} ${seatWord(license.quantity)} but ${license.seatsUsed} ${
            license.seatsUsed === 1 ? "is" : "are"
          } assigned. Unassign ${over} before assigning anyone else.`}
        </p>
      ) : null}

      {holders.length > 0 ? (
        <ul className="divide-y rounded-notice border">
          {holders.map((seat) => (
            <SeatRow
              key={seat.membershipId}
              seat={seat}
              member={members.find((member) => member.membershipId === seat.membershipId)}
              busy={busy}
              onRelease={() => onRelease(license.licenseId, seat.membershipId)}
            />
          ))}
        </ul>
      ) : null}

      {over > 0 ? null : license.seatsUsed >= license.quantity ? (
        <Restricted>Every seat is assigned.</Restricted>
      ) : candidates.length === 0 ? (
        <Restricted>Every member already has a seat.</Restricted>
      ) : (
        <AssignSeat
          label={label}
          candidates={candidates}
          busy={busy}
          onAssign={(membershipId) => onAssign(license.licenseId, membershipId)}
        />
      )}
    </article>
  );
}

function SeatRow({
  seat,
  member,
  busy,
  onRelease,
}: {
  seat: LicenseSeatView;
  member: MemberView | undefined;
  busy: boolean;
  onRelease(): void;
}) {
  const label = member ? memberLabel(member) : seat.mentraUserId;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Avatar label={label} />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold [overflow-wrap:anywhere]">{label}</div>
        <div className="text-muted-foreground text-xs">{`Since ${formatDate(seat.assignedAt)}`}</div>
      </div>
      <ConfirmButton
        label="Unassign"
        ariaLabel={`Unassign ${label}`}
        prompt={`Unassign ${label}'s seat?`}
        confirmLabel="Confirm unassign"
        disabled={busy}
        onConfirm={onRelease}
      />
    </li>
  );
}

/** Choose a member who has no seat, and give them one. */
function AssignSeat({
  label,
  candidates,
  busy,
  onAssign,
}: {
  label: string;
  candidates: readonly MemberView[];
  busy: boolean;
  onAssign(membershipId: string): void;
}) {
  const [chosen, setChosen] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen) return;
    onAssign(chosen);
    setChosen("");
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
      <NativeSelect
        compact
        aria-label={`Member for ${label}`}
        value={chosen}
        disabled={busy}
        onChange={(event) => setChosen(event.target.value)}
      >
        <option value="">Choose a member</option>
        {candidates.map((member) => (
          <option key={member.membershipId} value={member.membershipId}>
            {memberLabel(member)}
          </option>
        ))}
      </NativeSelect>
      <Button type="submit" size="sm" disabled={busy || chosen === ""}>
        Assign seat
      </Button>
    </form>
  );
}
