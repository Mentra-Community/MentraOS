/**
 * The workspace's members and their roles.
 *
 * Role selectors offer only the transitions `canChangeRole` allows the viewer, and Remove only appears
 * where removal is theirs to do. The API enforces the same rules; this just never offers a control
 * that is certain to be refused. Each change carries the revision the viewer last saw, so a stale view
 * ends in "This workspace changed" and a refetch rather than in an overwrite.
 */

import { useQuery } from "@tanstack/react-query";
import type { MemberView, WorkspaceDetail, WorkspaceRole } from "@mentra/workspace-contract";
import type { WorkspaceApi } from "../api";
import { formatDate } from "../lib/format";
import { membersQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can, canRemoveRole, effectiveRole, ROLE_LABELS, roleOptions } from "../roles";
import { NativeSelect } from "../ui/native-select";
import { Badge, ConfirmButton, ErrorNotice, Panel, QueryGate, Restricted, RoleBadge } from "./common";

export function WorkspaceMembersPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
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
    <Panel title="Members" description="People in this workspace and the role each of them holds.">
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
  busy,
  onChangeRole,
  onRemove,
}: {
  detail: WorkspaceDetail;
  members: MemberView[];
  busy: boolean;
  onChangeRole(membershipId: string, role: WorkspaceRole): void;
  onRemove(membershipId: string): void;
}) {
  const viewer = effectiveRole(detail);
  const canManage = can(detail, "workspace.members.manage");
  const ownMembershipId = detail.membership?.membershipId ?? null;

  if (members.length === 0) return <Restricted>No members yet.</Restricted>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            <th className="py-2 pr-4 font-medium">Member</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 font-medium">Joined</th>
            <th className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const label = member.name ?? member.email ?? "Unnamed member";
            const isSelf = member.membershipId === ownMembershipId;
            const options = canManage ? roleOptions(viewer, member.role) : [];
            return (
              <tr key={member.membershipId} className="border-t">
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{label}</span>
                    {isSelf ? <Badge>You</Badge> : null}
                    {member.pending ? <Badge>Pending first sign-in</Badge> : null}
                  </div>
                  {member.name && member.email ? (
                    <div className="text-muted-foreground text-xs">{member.email}</div>
                  ) : null}
                </td>
                <td className="py-2 pr-4">
                  {options.length > 0 ? (
                    <NativeSelect
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
                <td className="text-muted-foreground py-2 pr-4">{formatDate(member.startedAt)}</td>
                <td className="py-2 text-right">
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
