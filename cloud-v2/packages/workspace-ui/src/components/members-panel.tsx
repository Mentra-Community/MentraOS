/**
 * The workspace's members and their roles.
 *
 * Role selectors offer only the transitions `canChangeRole` allows the viewer, and Remove only appears
 * where removal is theirs to do. The API enforces the same rules; this just never offers a control
 * that is certain to be refused. The viewer's own row never has a role selector: a select commits on
 * change, and one stray keystroke must not demote an owner, so their role is changed by another owner
 * or an Organization Admin. Each change carries the revision the viewer last saw, so a stale view
 * ends in "This workspace changed" and a refetch rather than in an overwrite.
 *
 * `showUserIds` shows each member's Mentra user id with a copy button, for Organization Admins who need
 * it to recover a workspace's ownership. Leave it off anywhere else.
 *
 * A member imported from the Store who has not signed in yet is marked "Pending first sign-in". They
 * hold their role and are managed like anyone else, but have no Mentra user id until they sign in.
 */

import { useQuery } from "@tanstack/react-query";
import type { MemberView, WorkspaceDetail, WorkspaceRole } from "@mentra/workspace-contract";
import type { WorkspaceApi } from "../api";
import { formatDate } from "../lib/format";
import { membersQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can, canRemoveRole, effectiveRole, ROLE_LABELS, roleOptions } from "../roles";
import { NativeSelect } from "../ui/native-select";
import { Avatar, Badge, ConfirmButton, CopyButton, ErrorNotice, Panel, QueryGate, Restricted, RoleBadge } from "./common";

export function WorkspaceMembersPanel({
  api,
  workspaceId,
  showUserIds = false,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  /** Show each member's Mentra user id (Organization Admins, for ownership recovery). */
  showUserIds?: boolean;
}) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const membersResult = useQuery({
    ...membersQuery(api, workspaceId),
    enabled: can(detailResult.data, "workspace.members.read"),
  });

  const changeRole = useWorkspaceMutation(
    api,
    workspaceId,
    (change: { membershipId: string; role: WorkspaceRole; expectedRevision: number }) =>
      api.changeMemberRole(workspaceId, change.membershipId, change.role, change.expectedRevision),
  );
  const remove = useWorkspaceMutation(api, workspaceId, (target: { membershipId: string; expectedRevision: number }) =>
    api.removeMember(workspaceId, target.membershipId, target.expectedRevision),
  );

  return (
    <Panel
      title="Members"
      count={can(detailResult.data, "workspace.members.read") ? membersResult.data?.length : undefined}
      description="People in this workspace and the role each of them holds."
    >
      <QueryGate result={detailResult}>
        {(detail) =>
          !can(detail, "workspace.members.read") ? (
            <Restricted>Only workspace admins can see the member list.</Restricted>
          ) : (
            <QueryGate result={membersResult}>
              {(members) => (
                <MembersTable
                  detail={detail}
                  members={members}
                  showUserIds={showUserIds}
                  busy={changeRole.isPending || remove.isPending}
                  onChangeRole={(membershipId, role) => {
                    remove.reset();
                    changeRole.mutate({ membershipId, role, expectedRevision: detail.authorizationRevision });
                  }}
                  onRemove={(membershipId) => {
                    changeRole.reset();
                    remove.mutate({ membershipId, expectedRevision: detail.authorizationRevision });
                  }}
                />
              )}
            </QueryGate>
          )
        }
      </QueryGate>
      <ErrorNotice error={changeRole.error ?? remove.error} />
    </Panel>
  );
}

function MembersTable({
  detail,
  members,
  showUserIds,
  busy,
  onChangeRole,
  onRemove,
}: {
  detail: WorkspaceDetail;
  members: MemberView[];
  showUserIds: boolean;
  busy: boolean;
  onChangeRole(membershipId: string, role: WorkspaceRole): void;
  onRemove(membershipId: string): void;
}) {
  const viewer = effectiveRole(detail);
  const canManage = can(detail, "workspace.members.manage");
  const ownMembershipId = detail.membership?.membershipId ?? null;

  if (members.length === 0) return <Restricted>No members yet.</Restricted>;
  return (
    // On a phone each row stacks: the member across the top, their role and Remove under it.
    <div className="-mx-6 overflow-x-auto max-sm:border-t">
      <table className="w-full text-left text-sm max-sm:block">
        <thead className="text-muted-foreground border-y text-xs max-sm:hidden">
          <tr>
            <th className="py-3 pr-4 pl-6 font-semibold">Member</th>
            <th className="py-3 pr-4 font-semibold">Role</th>
            <th className="hidden py-3 pr-4 font-semibold sm:table-cell">Joined</th>
            <th className="py-3 pr-6 font-semibold">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {members.map((member) => {
            const label = member.email ?? member.mentraUserId ?? "Imported member";
            const isSelf = member.membershipId === ownMembershipId;
            const options = canManage && !isSelf ? roleOptions(viewer, member.role) : [];
            return (
              <tr
                key={member.membershipId}
                className="border-b last:border-b-0 max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-3 max-sm:px-6 max-sm:py-4"
              >
                <td className="py-3.5 pr-4 pl-6 max-sm:col-span-2 max-sm:p-0">
                  <div className="flex items-center gap-3">
                    <Avatar label={label} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-semibold [overflow-wrap:anywhere]">{label}</span>
                        {isSelf ? <Badge>You</Badge> : null}
                        {member.pending ? <Badge>Pending first sign-in</Badge> : null}
                      </div>
                      {showUserIds && member.mentraUserId ? (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <code className="text-muted-foreground font-mono text-xs select-all">{member.mentraUserId}</code>
                          <CopyButton
                            text={member.mentraUserId}
                            label="Copy id"
                            ariaLabel={`Copy the Mentra user id of ${label}`}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td className="py-3.5 pr-4 max-sm:p-0">
                  {options.length > 0 ? (
                    <NativeSelect
                      compact
                      aria-label={`Role for ${label}`}
                      value={member.role}
                      disabled={busy}
                      onChange={(event) => onChangeRole(member.membershipId, event.target.value as WorkspaceRole)}
                    >
                      {options.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <RoleBadge role={member.role} />
                  )}
                </td>
                <td className="text-muted-foreground hidden py-3.5 pr-4 whitespace-nowrap sm:table-cell">
                  {formatDate(member.startedAt)}
                </td>
                <td className="py-3.5 pr-6 text-right max-sm:p-0">
                  {canManage && !isSelf && canRemoveRole(viewer, member.role) ? (
                    <ConfirmButton
                      label="Remove"
                      ariaLabel={`Remove ${label}`}
                      prompt={`Remove ${label} from this workspace?`}
                      confirmLabel="Confirm remove"
                      disabled={busy}
                      onConfirm={() => onRemove(member.membershipId)}
                    />
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
