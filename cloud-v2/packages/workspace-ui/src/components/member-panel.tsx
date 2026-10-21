/**
 * The member panel: a side panel over the Members list for one member. It shows who they are, their role (with
 * Change role where the viewer may move them, never on their own row) and when they joined, then their licenses
 * (one switch per license the workspace holds, where the host has a licenses source) and Remove from workspace
 * (which asks first, where the viewer may remove them). It has no devices, usage or miniapps: those are Fleet
 * Management's Person page, and Members doesn't compete with it.
 *
 * The panel itself holds no data. `WorkspaceMembersPanel` works out what the viewer may do (`roleOptions`,
 * `canRemove`) and runs the role change and the removal, so the admin portal, which has no licenses, gets the
 * same panel without the Licenses section. `PersonLicenses` is that section: its switches give a seat with
 * `PUT` and take it back with `DELETE` at once, through `useSeatMutation` so billing's status is read again.
 *
 * Every sentence is in `strings/licenses.ts`. This file imports no runtime code from the contract's billing
 * schemas, so the admin portal doesn't carry zod for it.
 */

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { MemberView, WorkspaceRole } from "@mentra/workspace-contract";
import type { WorkspaceApi } from "../api";
import { billingErrorMessage } from "../billing-errors";
import { isLicenseChangedError } from "../errors";
import { formatDate } from "../lib/format";
import { holdsSeat, type JoinedLicense } from "../lib/license-join";
import { cn } from "../lib/utils";
import { useSeatMutation } from "../queries";
import { ROLE_LABELS } from "../roles";
import { licenseStrings as t } from "../strings/licenses";
import { Menu, type MenuItem } from "../ui/menu";
import { SidePanel } from "../ui/side-panel";
import { Switch } from "../ui/switch";
import { Avatar, Badge, ConfirmButton, ErrorNotice } from "./common";
import { HostedPageButton } from "./licenses/parts";
import { ProductIcon } from "./licenses/product";

/** What a member is called: their name, else their email, else their Mentra user id, else "Imported member". */
export function memberLabel(member: Pick<MemberView, "name" | "email" | "mentraUserId">): string {
  return member.name?.trim() || member.email || member.mentraUserId || t.members.importedMember;
}

/** A failure in the page's amber: `role="alert"`, because it is the answer to something the person just did. */
export function AlertText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
      {children}
    </p>
  );
}

/**
 * Why a seat change failed. A license that changed under the person (every seat taken, or gone) is "Seats changed
 * while you were choosing. Nothing was assigned." because the screen has already read the counts again; anything
 * else is the server's own words. Nothing when there is no error.
 */
export function SeatErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  if (isLicenseChangedError(error)) return <AlertText>{t.conflict.seatsChanged}</AlertText>;
  return <ErrorNotice error={error} />;
}

/**
 * "Add seats ↗" for a license: asks the host (which asks billing for a session and leaves the portal). While the
 * request is out the button is pending, and a refusal comes back as its words. The host's call is made inside the
 * click, so a tab it opens there isn't blocked.
 */
export function useAddSeats(onAddSeats: ((licenseId: string) => unknown) | undefined) {
  const [state, setState] = useState<{ pending: string | null; message: string | null }>({ pending: null, message: null });
  function run(card: Pick<JoinedLicense, "licenseId" | "name">) {
    if (!onAddSeats) return;
    setState({ pending: card.licenseId, message: null });
    let result: unknown;
    try {
      result = onAddSeats(card.licenseId);
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result).then(
      () => setState((current) => (current.pending === card.licenseId ? { pending: null, message: null } : current)),
      (error: unknown) => setState({ pending: null, message: billingErrorMessage(error, { product: card.name }) }),
    );
  }
  return { pending: state.pending, message: state.message, run };
}

export interface PersonLicensesProps {
  api: WorkspaceApi;
  workspaceId: string;
  member: MemberView;
  /** The licenses the workspace holds, in the order to show them. Each has Core's license. */
  cards: readonly JoinedLicense[];
  /** Whether the viewer may give and take seats (`workspace.licenses.assign`). Without it the switches show the state only. */
  canAssign: boolean;
  /** Whether "Add seats ↗" is offered for the license: billing lists `add_seats` for it and the host can start it. */
  canAddSeats(card: JoinedLicense): boolean;
  onAddSeats?(licenseId: string): unknown;
}

/** A member's Licenses: one row per license the workspace holds, with a switch and the seats left. */
export function PersonLicenses({ api, workspaceId, member, cards, canAssign, canAddSeats, onAddSeats }: PersonLicensesProps) {
  const heading = useId();
  const name = memberLabel(member);
  const assign = useSeatMutation(api, workspaceId, (change: { licenseId: string; membershipId: string }) =>
    api.assignSeat(workspaceId, change.licenseId, change.membershipId),
  );
  const release = useSeatMutation(api, workspaceId, (change: { licenseId: string; membershipId: string }) =>
    api.releaseSeat(workspaceId, change.licenseId, change.membershipId),
  );
  const add = useAddSeats(onAddSeats);
  const busy = assign.isPending || release.isPending;
  // The switch shows where it is going while the request is out.
  const moving = assign.isPending ? { licenseId: assign.variables.licenseId, on: true } : release.isPending ? { licenseId: release.variables.licenseId, on: false } : null;
  const signedIn = !member.pending;

  return (
    <section aria-labelledby={heading} className="space-y-3">
      <div>
        <h3 id={heading} className="text-lg leading-tight font-semibold">
          {t.memberPanel.licenses}
        </h3>
        {signedIn && canAssign ? <p className="text-muted-foreground mt-1 text-sm">{t.memberPanel.intro(name)}</p> : null}
      </div>
      {signedIn ? (
        <ul className="divide-y overflow-hidden rounded-notice border">
          {cards.map((card) => {
            const counts = card.seats!;
            const held = holdsSeat(card.license!, member.membershipId);
            const on = moving?.licenseId === card.licenseId ? moving.on : held;
            const over = !on && counts.over > 0;
            const full = !on && !over && counts.free === 0;
            const warn = over || full;
            const text = on
              ? t.memberPanel.hasASeat(counts.free, counts.quantity)
              : over
                ? t.memberPanel.overAssigned(counts.over)
                : full
                  ? t.memberPanel.allInUse(counts.quantity)
                  : t.memberPanel.seatsFree(counts.free, counts.quantity);
            return (
              <li key={card.licenseId} className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5">
                <ProductIcon product={card} size={40} />
                <div className="min-w-0 flex-1 basis-36">
                  <div data-slot="license-name" className="text-[15px] font-semibold">
                    {card.name}
                  </div>
                  <div
                    data-tone={warn ? "warn" : undefined}
                    className={cn("text-[13px] leading-5", warn ? "text-error-foreground font-semibold" : "text-muted-foreground")}
                  >
                    {text}
                  </div>
                </div>
                {full && canAddSeats(card) ? (
                  <HostedPageButton pending={add.pending === card.licenseId} onClick={() => add.run(card)}>
                    {t.actions.addSeats}
                  </HostedPageButton>
                ) : null}
                <Switch
                  aria-label={t.memberPanel.seatSwitch(card.name, name)}
                  checked={on}
                  disabled={!canAssign || busy || over || full}
                  onChange={(event) => {
                    if (!canAssign) return;
                    const change = { licenseId: card.licenseId, membershipId: member.membershipId };
                    if (event.target.checked) {
                      release.reset();
                      assign.mutate(change);
                    } else {
                      assign.reset();
                      release.mutate(change);
                    }
                  }}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t.memberPanel.afterFirstSignIn(member.email ?? name)}</p>
      )}
      <SeatErrorNotice error={assign.error ?? release.error} />
      {add.message ? <AlertText>{add.message}</AlertText> : null}
    </section>
  );
}

export interface MemberPanelProps {
  /** The member the panel is for; null while it is closed. */
  member: MemberView | null;
  /** The person asked to close it (×, Escape, the dimmed page). */
  onClose(): void;
  /** The roles Change role offers: the member's own and what may replace it. Empty where the viewer may not change it. */
  roleOptions: readonly WorkspaceRole[];
  /** Whether the viewer may remove the member. */
  canRemove: boolean;
  /** A role change or a removal is out: the controls wait. */
  busy: boolean;
  onChangeRole(role: WorkspaceRole): void;
  onRemove(): void;
  /** The failure of the last role change or removal. */
  error: unknown;
  /** The portal's locale, for the joining date. */
  locale?: string;
  /** The Licenses section, where the host has one. */
  licenses?: ReactNode;
}

/** A side panel over the Members list for one member. See the file's note. */
export function MemberPanel({ member, onClose, roleOptions, canRemove, busy, onChangeRole, onRemove, error, locale, licenses }: MemberPanelProps) {
  const name = member ? memberLabel(member) : "";
  return (
    <SidePanel
      open={member !== null}
      onClose={onClose}
      title={name}
      description={member?.name?.trim() && member.email ? member.email : undefined}
    >
      {member ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Avatar label={name} className="size-12 text-sm" />
            <dl className="flex min-w-0 flex-1 flex-wrap gap-x-10 gap-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs font-semibold">{t.memberPanel.role}</dt>
                <dd className="mt-1 font-semibold">{ROLE_LABELS[member.role]}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs font-semibold">{t.memberPanel.joined}</dt>
                <dd className="mt-1 font-semibold">{formatDate(member.startedAt, locale)}</dd>
              </div>
            </dl>
            {member.pending ? <Badge>{t.members.pendingFirstSignIn}</Badge> : null}
          </div>
          {roleOptions.length > 0 || canRemove ? (
            <div className="flex flex-wrap items-center gap-2">
              {roleOptions.length > 0 ? <ChangeRole current={member.role} options={roleOptions} disabled={busy} onChange={onChangeRole} /> : null}
              {canRemove ? (
                <ConfirmButton
                  label={t.memberPanel.remove}
                  ariaLabel={t.memberPanel.remove}
                  prompt={t.memberPanel.removePrompt(name)}
                  confirmLabel={t.memberPanel.removeConfirm}
                  disabled={busy}
                  onConfirm={onRemove}
                />
              ) : null}
            </div>
          ) : null}
          <ErrorNotice error={error} />
          {licenses}
        </>
      ) : null}
    </SidePanel>
  );
}

/** Change role as a menu of the roles the viewer may move the member between. The role they hold is marked and can't be chosen again. */
function ChangeRole({
  current,
  options,
  disabled,
  onChange,
}: {
  current: WorkspaceRole;
  options: readonly WorkspaceRole[];
  disabled: boolean;
  onChange(role: WorkspaceRole): void;
}) {
  const items: MenuItem[] = options.map((role) => ({
    key: role,
    label: (
      <span className="flex w-full items-center justify-between gap-4">
        {ROLE_LABELS[role]}
        {role === current ? <CheckIcon aria-hidden="true" className="size-4" /> : null}
      </span>
    ),
    disabled: role === current,
    onSelect: () => onChange(role),
  }));
  return (
    <Menu
      label={t.memberPanel.changeRole}
      trigger={
        <>
          {t.memberPanel.changeRole}
          <ChevronDownIcon aria-hidden="true" />
        </>
      }
      items={items}
      align="start"
      variant="secondary"
      size="sm"
      disabled={disabled}
    />
  );
}
