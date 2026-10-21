/**
 * The workspace's members: who they are, the role each holds, when they joined and, where the host has a
 * licenses source, the licenses they hold.
 *
 * A row shows the member's name over their email (the email alone where Core has none), their role as a badge, their
 * licenses and when they joined. Nothing on it opens anything: licenses are assigned from the Licenses page, so the
 * chips only show, and there is no selection, no bulk "Assign licenses" and no side panel. Changing a role and
 * removing a member are in the row's "…" menu, under the rules they always had: Change role offers only the roles
 * `roleOptions` allows the viewer, and Remove from workspace only where removal is theirs to do; neither is ever
 * offered for the viewer's own membership (a stray click must not demote an owner, so their role is changed by
 * another owner or an Organization Admin). Remove asks first, in a dialog. Each change carries the revision the
 * viewer last saw, so a stale view ends in "This workspace changed" and a refetch rather than in an overwrite.
 *
 * `licenses` is the host's licenses source (the workspace portal passes it, the admin portal doesn't): billing's
 * catalog, which names and draws each license. Given it, and for a viewer with `workspace.licenses.read` in a workspace
 * that holds licenses, the list gains a Licenses column: a chip per license held, "None", or "After first sign-in";
 * past four, three chips and "+n". If billing's catalog can't be read the host passes none, and the list works
 * without the column.
 *
 * `showUserIds` shows each member's Mentra user id with a copy button, for Organization Admins who need it to
 * recover a workspace's ownership. Leave it off anywhere else.
 *
 * A member imported from the Store who has not signed in yet is marked "Pending first sign-in". They hold their
 * role and are managed like anyone else, but have no Mentra user id and can hold no license until they sign in.
 */

import { useQuery } from "@tanstack/react-query";
import { MoreHorizontalIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MemberView, WorkspaceRole } from "@mentra/workspace-contract";
import type { CatalogEntry } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../api";
import { errorMessage } from "../errors";
import { formatDate } from "../lib/format";
import { holdsSeat, joinLicenses } from "../lib/license-join";
import { cn } from "../lib/utils";
import { licensesQuery, membersQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can, canRemoveRole, effectiveRole, ROLE_LABELS, roleOptions } from "../roles";
import { licenseStrings as t } from "../strings/licenses";
import { Menu, type MenuItem } from "../ui/menu";
import { Avatar, Badge, CopyButton, ErrorNotice, Panel, QueryGate, Restricted, RoleBadge } from "./common";
import { ConfirmDialog } from "./confirm-dialog";
import { isHeldLicense, memberLabel, type HeldLicense } from "./licenses/parts";
import { ProductChip } from "./licenses/product";

/**
 * What the host knows about licenses, for the Members list. The workspace portal passes it; the admin portal doesn't.
 * The list only shows licenses, so all it needs is what names them.
 */
export interface MembersLicenses {
  /**
   * Billing's catalog (`catalog.products`): what names and draws each license. Null or undefined while it can't be
   * read (still loading, or it failed): the Licenses column is left out.
   */
  catalog: readonly CatalogEntry[] | null | undefined;
}

/** How many chips a member's Licenses cell shows before it folds the rest into "+n". */
const MAX_CHIPS = 4;

/** What the viewer may do to one member: the roles they may move them to (never the one held), and whether they may remove them. */
interface RowActions {
  roles: readonly WorkspaceRole[];
  canRemove: boolean;
}

export function WorkspaceMembersPanel({
  api,
  workspaceId,
  showUserIds = false,
  licenses,
  locale,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  /** Show each member's Mentra user id (Organization Admins, for ownership recovery). */
  showUserIds?: boolean;
  /** The licenses source. Leave it out where the host shows no licenses (the admin portal). */
  licenses?: MembersLicenses;
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
  // The licenses the workspace holds, named from the catalog. The Members list deliberately keeps Core's own order
  // (the order the licenses were bought, `_id` ascending) and not the Licenses page's (a problem first, then by
  // name): a member's chips stay where they are when a payment fails. `joinLicenses` sorts for the page, so its
  // order is put back.
  const cards = useMemo<HeldLicense[]>(() => {
    if (catalog === undefined || !licensesResult.data) return [];
    const order = new Map(licensesResult.data.map((license, index) => [license.licenseId, index]));
    return joinLicenses({ licenses: licensesResult.data, catalog, locale })
      .filter(isHeldLicense)
      .sort((a, b) => order.get(a.licenseId)! - order.get(b.licenseId)!);
  }, [catalog, licensesResult.data, locale]);
  const licensesShown = can(detail, "workspace.licenses.read") && cards.length > 0;

  const changeRole = useWorkspaceMutation(
    api,
    workspaceId,
    (change: { membershipId: string; role: WorkspaceRole; expectedRevision: number }) =>
      api.changeMemberRole(workspaceId, change.membershipId, change.role, change.expectedRevision),
  );
  // Removing a member frees their licenses in the same transaction, so it refreshes billing's status like a change of who holds one.
  const remove = useWorkspaceMutation(
    api,
    workspaceId,
    (target: { membershipId: string; expectedRevision: number }) => api.removeMember(workspaceId, target.membershipId, target.expectedRevision),
    { seats: true },
  );

  // Who Remove is asking about, and the menus' buttons, so that a dialog closed without removing gives focus back.
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const menus = useRef(new Map<string, HTMLElement>());
  const returnFocusTo = useRef<string | null>(null);
  useEffect(() => {
    if (removing === null && returnFocusTo.current !== null) {
      menus.current.get(returnFocusTo.current)?.querySelector("button")?.focus();
      returnFocusTo.current = null;
    }
  }, [removing]);
  const busy = changeRole.isPending || remove.isPending;

  return (
    <Panel
      title={t.members.title}
      count={can(detail, "workspace.members.read") ? membersResult.data?.length : undefined}
      description={t.members.description}
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
                const actionsFor = (member: MemberView): RowActions | null => {
                  if (!canManage || member.membershipId === ownMembershipId) return null;
                  const roles = roleOptions(viewer, member.role).filter((role) => role !== member.role);
                  const canRemove = canRemoveRole(viewer, member.role);
                  return roles.length > 0 || canRemove ? { roles, canRemove } : null;
                };
                return (
                  <>
                    {/* A role change that failed, in words; a refused removal is shown in its own dialog. */}
                    <ErrorNotice error={changeRole.error} tone="neutral" />
                    <MembersTable
                      members={members}
                      ownMembershipId={ownMembershipId}
                      showUserIds={showUserIds}
                      cards={licensesShown ? cards : null}
                      managed={canManage}
                      actionsFor={actionsFor}
                      busy={busy}
                      locale={locale}
                      registerMenu={(membershipId, element) => {
                        if (element) menus.current.set(membershipId, element);
                        else menus.current.delete(membershipId);
                      }}
                      onChangeRole={(member, role) => {
                        remove.reset();
                        changeRole.mutate({ membershipId: member.membershipId, role, expectedRevision: workspace.authorizationRevision });
                      }}
                      onRemove={(member) => {
                        changeRole.reset();
                        setRemoving(member);
                      }}
                    />
                    {removing ? (
                      <ConfirmDialog
                        title={t.members.removePrompt(memberLabel(removing))}
                        description={t.members.removeBody}
                        cancelLabel={t.members.cancel}
                        confirmLabel={t.members.removeConfirm}
                        onConfirm={async () => {
                          remove.reset();
                          try {
                            await remove.mutateAsync({ membershipId: removing.membershipId, expectedRevision: workspace.authorizationRevision });
                            return null;
                          } catch (error) {
                            return errorMessage(error);
                          }
                        }}
                        onClose={(done) => {
                          // Backed out: the row's menu button is where the person was. Removed: the row is going.
                          if (!done) returnFocusTo.current = removing.membershipId;
                          setRemoving(null);
                        }}
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
  managed,
  actionsFor,
  busy,
  locale,
  registerMenu,
  onChangeRole,
  onRemove,
}: {
  members: MemberView[];
  ownMembershipId: string | null;
  showUserIds: boolean;
  /** The licenses the workspace holds, for the Licenses column; null leaves the column out. */
  cards: readonly HeldLicense[] | null;
  /** The viewer may manage members: the table has a column for the row's menu. */
  managed: boolean;
  actionsFor(member: MemberView): RowActions | null;
  /** A change is out: the menus wait. */
  busy: boolean;
  locale?: string;
  registerMenu(membershipId: string, element: HTMLElement | null): void;
  onChangeRole(member: MemberView, role: WorkspaceRole): void;
  onRemove(member: MemberView): void;
}) {
  if (members.length === 0) return <Restricted>{t.members.noMembers}</Restricted>;
  return (
    // On a phone each row stacks: the member across the top (with the menu beside them), then their role and their licenses.
    // A row's menu opens over the list, so the table does not clip it where it has room (a phone, a desktop); only in
    // between does it scroll sideways.
    <div className="-mx-6 overflow-x-auto max-sm:overflow-visible max-sm:border-t lg:overflow-visible">
      <table className="w-full text-left text-sm max-sm:block">
        <thead className="text-muted-foreground border-y text-xs max-sm:hidden">
          <tr>
            <th className="py-3 pr-4 pl-6 font-semibold">{t.members.member}</th>
            <th className="py-3 pr-4 font-semibold">{t.members.role}</th>
            {cards ? <th className="py-3 pr-4 font-semibold">{t.members.licenses}</th> : null}
            <th className="py-3 pr-6 font-semibold">{t.members.joined}</th>
            {managed ? <th aria-hidden="true" className="w-12 py-3 pr-4" /> : null}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {members.map((member) => {
            const label = memberLabel(member);
            const isSelf = member.membershipId === ownMembershipId;
            const email = member.name?.trim() && member.email ? member.email : null;
            const actions = actionsFor(member);
            const items: MenuItem[] = actions
              ? [
                  ...actions.roles.map((role) => ({
                    key: role,
                    label: t.members.changeRoleTo(ROLE_LABELS[role]),
                    onSelect: () => onChangeRole(member, role),
                  })),
                  ...(actions.canRemove ? [{ key: "remove", label: t.members.remove, destructive: true, onSelect: () => onRemove(member) }] : []),
                ]
              : [];
            return (
              <tr
                key={member.membershipId}
                className="border-b last:border-b-0 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-2.5 max-sm:px-5 max-sm:py-4"
              >
                <td className={cn("py-3.5 pr-4 pl-6 max-sm:order-1 max-sm:min-w-0 max-sm:flex-1 max-sm:p-0", managed ? "max-sm:basis-[calc(100%-3rem)]" : "max-sm:basis-full")}>
                  <div className="flex min-w-0 items-center gap-3">
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
                  </div>
                  {showUserIds && member.mentraUserId ? (
                    // Under the name, not under the avatar: the avatar is 36px and the gap 12px.
                    <div className="mt-1 ml-12 flex flex-wrap items-center gap-2">
                      <code className="text-muted-foreground font-mono text-xs select-all">{member.mentraUserId}</code>
                      <CopyButton text={member.mentraUserId} label={t.members.copyId} ariaLabel={t.members.copyIdFor(label)} />
                    </div>
                  ) : null}
                </td>
                <td className="py-3.5 pr-4 max-sm:order-3 max-sm:p-0">
                  <RoleBadge role={member.role} />
                </td>
                {cards ? (
                  <td className="py-3.5 pr-4 max-sm:order-3 max-sm:min-w-40 max-sm:flex-1 max-sm:p-0">
                    <LicensesCell member={member} cards={cards} />
                  </td>
                ) : null}
                <td className="text-muted-foreground hidden py-3.5 pr-6 whitespace-nowrap sm:table-cell">
                  {formatDate(member.startedAt, locale)}
                </td>
                {managed ? (
                  <td className="py-3.5 pr-4 text-right max-sm:order-2 max-sm:w-9 max-sm:p-0">
                    {items.length > 0 ? (
                      <span ref={(element) => registerMenu(member.membershipId, element)} className="inline-block">
                        <Menu
                          label={t.members.moreFor(label)}
                          trigger={<MoreHorizontalIcon aria-hidden="true" />}
                          items={items}
                          disabled={busy}
                          className="text-muted-foreground"
                        />
                      </span>
                    ) : null}
                  </td>
                ) : null}
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
