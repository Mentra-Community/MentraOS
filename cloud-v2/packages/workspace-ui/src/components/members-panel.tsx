/**
 * The workspace's members: who they are, the role each holds, when they joined and, where the host has a
 * licenses source, the licenses they hold.
 *
 * A row shows the member's name over their email (the email alone where Core has none), their role as a badge and
 * when they joined, and opens the member panel (`MemberPanel`). Changing a role and removing a member are in that
 * panel, under the same rules as before: Change role offers only the roles `roleOptions` allows the viewer, and
 * Remove only appears where removal is theirs to do; neither is ever offered for the viewer's own membership
 * (a stray click must not demote an owner, so their role is changed by another owner or an Organization Admin).
 * Each change carries the revision the viewer last saw, so a stale view ends in "This workspace changed" and a
 * refetch rather than in an overwrite. The panel is controlled through `member` and `onMemberChange` when the
 * host passes them (the workspace portal ties it to `?member=<membershipId>`), and by its own state otherwise
 * (the admin portal).
 *
 * `licenses` is the host's licenses source (the workspace portal passes it, the admin portal doesn't). Given it,
 * and for a viewer with `workspace.licenses.read` in a workspace that holds licenses, the list gains a Licenses
 * column (a chip per license held, "None", or "After first sign-in"; past four, three chips and "+n"), and the
 * panel its Licenses section. With `workspace.licenses.assign` it also gains a checkbox per member who has signed
 * in and a bar "<n> selected · Assign licenses · ×". If billing's catalog can't be read the host passes none, and
 * the list works without any of it. "Add licenses ↗" is offered only for a license billing lists `add_seats` for
 * (`licenses.billing`).
 *
 * `showUserIds` shows each member's Mentra user id with a copy button, for Organization Admins who need it to
 * recover a workspace's ownership. Leave it off anywhere else.
 *
 * A member imported from the Store who has not signed in yet is marked "Pending first sign-in". They hold their
 * role and are managed like anyone else, but have no Mentra user id and can hold no seat until they sign in.
 */

import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { MemberView, WorkspaceRole } from "@mentra/workspace-contract";
import type { CatalogEntry } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../api";
import { formatDate } from "../lib/format";
import { holdsSeat, joinLicenses } from "../lib/license-join";
import { cn } from "../lib/utils";
import { licensesQuery, membersQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can, canRemoveRole, effectiveRole, roleOptions } from "../roles";
import { licenseStrings as t } from "../strings/licenses";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Avatar, Badge, CopyButton, Panel, QueryGate, Restricted, RoleBadge } from "./common";
import { AssignLicensesDialog } from "./licenses/assign-licenses";
import { isHeldLicense, memberLabel, type AddSeatsSource, type HeldLicense } from "./licenses/parts";
import { ProductChip } from "./licenses/product";
import { MemberPanel, PersonLicenses } from "./member-panel";

/**
 * What the host knows about licenses, for the Members list. The workspace portal passes it; the admin portal doesn't.
 *
 * "Add licenses ↗" is one of the portal's hosted-page buttons like any other (`useHostedAction`), so the host gives what
 * that needs, as it does for the Licenses page: the billing client (`billingApi`) and the two ways out (`navigateOut`).
 * The workspace API is the panel's own `api` prop. Whether a license offers the button is `billing`'s to say.
 */
export interface MembersLicenses extends AddSeatsSource {
  /**
   * Billing's catalog (`catalog.products`): what names and draws each license. Null or undefined while it can't be
   * read (still loading, or it failed): the Licenses column, the selection and the panel's section are left out.
   */
  catalog: readonly CatalogEntry[] | null | undefined;
}

/** How many chips a member's Licenses cell shows before it folds the rest into "+n". */
const MAX_CHIPS = 4;

export function WorkspaceMembersPanel({
  api,
  workspaceId,
  showUserIds = false,
  licenses,
  member: openMemberId,
  onMemberChange,
  locale,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  /** Show each member's Mentra user id (Organization Admins, for ownership recovery). */
  showUserIds?: boolean;
  /** The licenses source. Leave it out where the host shows no licenses (the admin portal). */
  licenses?: MembersLicenses;
  /** The membership whose panel is open (null or undefined: closed). Pass it with `onMemberChange` to control the panel; leave both out to let it keep its own. */
  member?: string | null;
  onMemberChange?(membershipId: string | null): void;
  /** The portal's locale, for dates. */
  locale?: string;
}) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const detail = detailResult.data;
  const membersResult = useQuery({
    ...membersQuery(api, workspaceId),
    enabled: can(detail, "workspace.members.read"),
  });

  const catalog = licenses?.catalog ?? undefined;
  const licensesResult = useQuery({
    ...licensesQuery(api, workspaceId),
    enabled: catalog !== undefined && can(detail, "workspace.licenses.read"),
  });
  // The licenses the workspace holds, named from the catalog. The Members screens deliberately keep Core's own order
  // (the order the licenses were bought, `_id` ascending) and not the Licenses page's (a problem first, then by
  // name): a member's chips, the rows of Assign licenses and the panel's switches stay where they are when a
  // payment fails. `joinLicenses` sorts for the page, so its order is put back.
  const cards = useMemo<HeldLicense[]>(() => {
    if (catalog === undefined || !licensesResult.data) return [];
    const order = new Map(licensesResult.data.map((license, index) => [license.licenseId, index]));
    return joinLicenses({ licenses: licensesResult.data, catalog, locale })
      .filter(isHeldLicense)
      .sort((a, b) => order.get(a.licenseId)! - order.get(b.licenseId)!);
  }, [catalog, licensesResult.data, locale]);
  const licensesShown = can(detail, "workspace.licenses.read") && cards.length > 0;
  const canSelect = licensesShown && can(detail, "workspace.licenses.assign");

  const changeRole = useWorkspaceMutation(
    api,
    workspaceId,
    (change: { membershipId: string; role: WorkspaceRole; expectedRevision: number }) =>
      api.changeMemberRole(workspaceId, change.membershipId, change.role, change.expectedRevision),
  );
  // Removing a member frees their seats in the same transaction, so it refreshes billing's status like a seat change.
  const remove = useWorkspaceMutation(
    api,
    workspaceId,
    (target: { membershipId: string; expectedRevision: number }) => api.removeMember(workspaceId, target.membershipId, target.expectedRevision),
    { seats: true },
  );

  // Which member's panel is open: the host's when it passes `member` or `onMemberChange`, else this panel's own.
  const controlled = openMemberId !== undefined || onMemberChange !== undefined;
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null);
  const openId = controlled ? (openMemberId ?? null) : ownOpenId;
  const setOpenId = (membershipId: string | null) => {
    if (controlled) onMemberChange?.(membershipId);
    else setOwnOpenId(membershipId);
  };
  // A failure belongs to the panel it happened in: the panel is modal and draws it, and one that outlives the panel (it
  // was closed, or another member's opened, while the request was out) is dropped with it, so nothing else shows it.
  const resetChangeRole = changeRole.reset;
  const resetRemove = remove.reset;
  useEffect(() => {
    resetChangeRole();
    resetRemove();
  }, [openId, resetChangeRole, resetRemove]);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  // Who is chosen: only members still listed who have signed in, in the list's order.
  const chosen = useMemo(
    () => (canSelect ? (membersResult.data ?? []).filter((member) => selectedIds.has(member.membershipId) && !member.pending) : []),
    [canSelect, membersResult.data, selectedIds],
  );

  const clearSelection = () => {
    setSelectedIds(new Set());
    setAssigning(false);
  };

  return (
    <Panel
      title={t.members.title}
      count={can(detail, "workspace.members.read") ? membersResult.data?.length : undefined}
      description={t.members.description}
      actions={
        chosen.length > 0 ? (
          <div
            data-slot="selection-bar"
            // On a phone it floats at the bottom of the screen: the header has no room for it.
            className="bg-foreground text-background flex items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-sm whitespace-nowrap max-sm:fixed max-sm:inset-x-4 max-sm:bottom-4 max-sm:z-30 max-sm:justify-between max-sm:shadow-dialog"
          >
            <span aria-live="polite" className="font-semibold">
              {t.members.selected(chosen.length)}
            </span>
            <Button type="button" size="sm" className="bg-background text-foreground" onClick={() => setAssigning(true)}>
              {t.members.assignLicenses}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t.members.clearSelection}
              className="text-background enabled:hover:bg-white/15"
              onClick={clearSelection}
            >
              <XIcon />
            </Button>
          </div>
        ) : undefined
      }
    >
      <QueryGate result={detailResult} tone="neutral">
        {(workspace) =>
          !can(workspace, "workspace.members.read") ? (
            <Restricted>{t.members.adminsOnly}</Restricted>
          ) : (
            <QueryGate result={membersResult} tone="neutral">
              {(members) => {
                const viewer = effectiveRole(workspace);
                const canManage = can(workspace, "workspace.members.manage");
                const ownMembershipId = workspace.membership?.membershipId ?? null;
                const target = members.find((candidate) => candidate.membershipId === openId) ?? null;
                const targetIsOther = target !== null && canManage && target.membershipId !== ownMembershipId;
                return (
                  <>
                    <MembersTable
                      members={members}
                      ownMembershipId={ownMembershipId}
                      showUserIds={showUserIds}
                      cards={licensesShown ? cards : null}
                      selectable={canSelect}
                      selected={selectedIds}
                      locale={locale}
                      onOpen={setOpenId}
                      onToggle={(membershipId) =>
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (next.has(membershipId)) next.delete(membershipId);
                          else next.add(membershipId);
                          return next;
                        })
                      }
                    />
                    <MemberPanel
                      member={target}
                      onClose={() => setOpenId(null)}
                      roleOptions={targetIsOther ? roleOptions(viewer, target.role) : []}
                      canRemove={targetIsOther && canRemoveRole(viewer, target.role)}
                      busy={changeRole.isPending || remove.isPending}
                      onChangeRole={(role) => {
                        if (!target) return;
                        remove.reset();
                        changeRole.mutate({ membershipId: target.membershipId, role, expectedRevision: workspace.authorizationRevision });
                      }}
                      onRemove={() => {
                        if (!target) return;
                        changeRole.reset();
                        remove.mutate(
                          { membershipId: target.membershipId, expectedRevision: workspace.authorizationRevision },
                          { onSuccess: () => setOpenId(null) },
                        );
                      }}
                      error={changeRole.error ?? remove.error}
                      locale={locale}
                      licenses={
                        target && licensesShown && licenses ? (
                          <PersonLicenses
                            // A new member starts with no failure of the last one's.
                            key={target.membershipId}
                            api={api}
                            workspaceId={workspaceId}
                            member={target}
                            cards={cards}
                            canAssign={canSelect}
                            addSeats={licenses}
                          />
                        ) : null
                      }
                    />
                    {licenses ? (
                      <AssignLicensesDialog
                        open={assigning && chosen.length > 0}
                        onClose={() => setAssigning(false)}
                        api={api}
                        workspaceId={workspaceId}
                        people={chosen}
                        cards={cards}
                        addSeats={licenses}
                        onAssigned={clearSelection}
                      />
                    ) : null}
                  </>
                );
              }}
            </QueryGate>
          )
        }
      </QueryGate>
    </Panel>
  );
}

/** The chips of the licenses a member holds: all of them up to four, else three and "+n". */
function LicenseChips({ held }: { held: readonly HeldLicense[] }) {
  const folded = held.length > MAX_CHIPS;
  const shown = folded ? held.slice(0, MAX_CHIPS - 1) : held;
  const hidden = folded ? held.slice(MAX_CHIPS - 1) : [];
  return (
    <ul aria-label={t.members.licenses} className="flex flex-wrap gap-1.5">
      {shown.map((card) => (
        <li key={card.licenseId}>
          <ProductChip product={card} />
        </li>
      ))}
      {folded ? (
        <li>
          <span
            title={hidden.map((card) => card.name).join(", ")}
            className="bg-background inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap"
          >
            {t.members.moreChips(hidden.length)}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

function MembersTable({
  members,
  ownMembershipId,
  showUserIds,
  cards,
  selectable,
  selected,
  locale,
  onOpen,
  onToggle,
}: {
  members: MemberView[];
  ownMembershipId: string | null;
  showUserIds: boolean;
  /** The licenses the workspace holds, for the Licenses column; null leaves the column out. */
  cards: readonly HeldLicense[] | null;
  selectable: boolean;
  selected: ReadonlySet<string>;
  locale?: string;
  onOpen(membershipId: string): void;
  onToggle(membershipId: string): void;
}) {
  if (members.length === 0) return <Restricted>{t.members.noMembers}</Restricted>;
  return (
    // On a phone each row stacks: the member across the top, then their role and their licenses.
    <div className="-mx-6 overflow-x-auto max-sm:border-t">
      <table className="w-full text-left text-sm max-sm:block">
        <thead className="text-muted-foreground border-y text-xs max-sm:hidden">
          <tr>
            {selectable ? <th aria-hidden="true" className="w-10 py-3 pl-6" /> : null}
            <th className={cn("py-3 pr-4 font-semibold", selectable ? "pl-2" : "pl-6")}>{t.members.member}</th>
            <th className="py-3 pr-4 font-semibold">{t.members.role}</th>
            {cards ? <th className="py-3 pr-4 font-semibold">{t.members.licenses}</th> : null}
            <th className="py-3 pr-6 font-semibold">{t.members.joined}</th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {members.map((member) => {
            const label = memberLabel(member);
            const isSelf = member.membershipId === ownMembershipId;
            const isSelected = selected.has(member.membershipId);
            const email = member.name?.trim() && member.email ? member.email : null;
            return (
              <tr
                key={member.membershipId}
                data-selected={isSelected ? "true" : undefined}
                // A click anywhere on the row opens the panel, except on what has a click of its own.
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest("button, input, a, label, code")) return;
                  onOpen(member.membershipId);
                }}
                className={cn(
                  "cursor-pointer border-b last:border-b-0 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-2.5 max-sm:px-5 max-sm:py-4",
                  isSelected && "bg-hover",
                )}
              >
                {selectable ? (
                  <td className="w-10 py-3.5 pl-6 max-sm:w-5 max-sm:p-0">
                    <label className="-m-2.5 flex size-10 cursor-pointer items-center justify-center has-[input:disabled]:cursor-not-allowed">
                      <Checkbox
                        aria-label={t.members.selectMember(label)}
                        checked={isSelected}
                        disabled={member.pending}
                        onChange={() => onToggle(member.membershipId)}
                      />
                    </label>
                  </td>
                ) : null}
                <td
                  className={cn(
                    "py-3.5 pr-4 max-sm:min-w-0 max-sm:flex-1 max-sm:p-0",
                    selectable ? "pl-2 max-sm:basis-[calc(100%-2.25rem)]" : "pl-6 max-sm:basis-full",
                  )}
                >
                  <button
                    type="button"
                    aria-label={t.members.openMember(label)}
                    onClick={() => onOpen(member.membershipId)}
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-[12px] text-left"
                  >
                    <Avatar label={label} />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span data-slot="member-name" className="text-[15px] font-semibold [overflow-wrap:anywhere]">
                          {label}
                        </span>
                        {isSelf ? <Badge>{t.members.you}</Badge> : null}
                        {member.pending ? <Badge>{t.members.pendingFirstSignIn}</Badge> : null}
                      </span>
                      {email ? (
                        <span data-slot="member-email" className="text-muted-foreground block text-[13px] [overflow-wrap:anywhere]">
                          {email}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {showUserIds && member.mentraUserId ? (
                    // Under the name, not under the avatar: the avatar is 36px and the gap 12px.
                    <div className="mt-1 ml-12 flex flex-wrap items-center gap-2">
                      <code className="text-muted-foreground font-mono text-xs select-all">{member.mentraUserId}</code>
                      <CopyButton text={member.mentraUserId} label={t.members.copyId} ariaLabel={t.members.copyIdFor(label)} />
                    </div>
                  ) : null}
                </td>
                <td className="py-3.5 pr-4 max-sm:p-0">
                  <RoleBadge role={member.role} />
                </td>
                {cards ? (
                  <td className="py-3.5 pr-4 max-sm:min-w-40 max-sm:flex-1 max-sm:p-0">
                    <LicensesCell member={member} cards={cards} />
                  </td>
                ) : null}
                <td className="text-muted-foreground hidden py-3.5 pr-6 whitespace-nowrap sm:table-cell">
                  {formatDate(member.startedAt, locale)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What a member holds: a chip per license, "None", or "After first sign-in" for someone who has no account yet. */
function LicensesCell({ member, cards }: { member: MemberView; cards: readonly HeldLicense[] }) {
  if (member.pending) return <span className="text-muted-foreground">{t.members.afterFirstSignIn}</span>;
  const held = cards.filter((card) => holdsSeat(card.license, member.membershipId));
  if (held.length === 0) return <span className="text-muted-foreground">{t.members.none}</span>;
  return <LicenseChips held={held} />;
}
