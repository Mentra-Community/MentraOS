/**
 * Pending invitations: list, revoke, and invite by email.
 *
 * The invitation link carries the only copy of its token, so after an invitation is created the link
 * lives in this panel's state until it is dismissed. It is never put in the query cache.
 */

import { useQuery } from "@tanstack/react-query";
import { canChangeRole, type WorkspaceRole } from "@mentra/workspace-contract";
import { useId, useState, type FormEvent } from "react";
import type { WorkspaceApi } from "../api";
import { formatDate } from "../lib/format";
import { invitationsQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { assignableRoles, can, effectiveRole, ROLE_LABELS } from "../roles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { ConfirmButton, CopyButton, ErrorNotice, Loading, LoadError, Panel, Restricted, RoleBadge } from "./common";

const TITLE = "Invitations";
const DESCRIPTION = "Invite people by email. An invitation can only be accepted by the address it was sent to.";

interface InvitationLink {
  email: string;
  role: WorkspaceRole;
  inviteUrl: string;
}

export function WorkspaceInvitationsPanel(props: { api: WorkspaceApi; workspaceId: string }) {
  // Keyed by workspace so a link shown for one workspace is never carried over to another.
  return <InvitationsPanel key={props.workspaceId} {...props} />;
}

function InvitationsPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const canManage = can(detailResult.data, "workspace.members.manage");
  const invitationsResult = useQuery({ ...invitationsQuery(api, workspaceId), enabled: canManage });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [link, setLink] = useState<InvitationLink | null>(null);
  const emailId = useId();
  const roleId = useId();

  const invite = useWorkspaceMutation(api, workspaceId, async (input: { email: string; role: WorkspaceRole }) => {
    const created = await api.createInvitation(workspaceId, input);
    setLink({ email: input.email, role: input.role, inviteUrl: created.inviteUrl });
    return created.invitationId;
  });
  const revoke = useWorkspaceMutation(api, workspaceId, (invitationId: string) =>
    api.revokeInvitation(workspaceId, invitationId),
  );

  if (detailResult.isPending) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Loading />
      </Panel>
    );
  }
  if (detailResult.isError) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <LoadError error={detailResult.error} onRetry={() => void detailResult.refetch()} />
      </Panel>
    );
  }
  if (!canManage) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Restricted>Only workspace admins can manage invitations.</Restricted>
      </Panel>
    );
  }

  const viewer = effectiveRole(detailResult.data);
  const invitable = assignableRoles(viewer, null);
  const selectedRole = invitable.includes(role) ? role : (invitable[0] ?? "member");
  const busy = invite.isPending || revoke.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    revoke.reset();
    invite.mutate({ email: address, role: selectedRole }, { onSuccess: () => setEmail("") });
  }

  return (
    <Panel title={TITLE} description={DESCRIPTION}>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={emailId}>Email address</Label>
          <Input
            id={emailId}
            type="email"
            required
            autoComplete="off"
            placeholder="teammate@example.com"
            className="w-72"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={roleId}>Role</Label>
          <NativeSelect
            id={roleId}
            aria-label="Invitation role"
            value={selectedRole}
            onChange={(event) => setRole(event.target.value as WorkspaceRole)}
          >
            {invitable.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={busy || email.trim() === ""}>
          Send invitation
        </Button>
      </form>

      {link ? (
        <div role="status" className="bg-muted space-y-2 rounded-md p-3 text-sm">
          <p>
            Invitation sent to <strong>{link.email}</strong> as {ROLE_LABELS[link.role]}. If the email does not arrive,
            share this link. It only works for someone signed in with that address.
          </p>
          <code className="bg-background block rounded border p-2 text-xs break-all select-all">{link.inviteUrl}</code>
          <div className="flex gap-2">
            <CopyButton text={link.inviteUrl} label="Copy link" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setLink(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {invitationsResult.isPending ? (
        <Loading />
      ) : invitationsResult.isError ? (
        <LoadError error={invitationsResult.error} onRetry={() => void invitationsResult.refetch()} />
      ) : invitationsResult.data.length === 0 ? (
        <Restricted>No pending invitations.</Restricted>
      ) : (
        <ul className="divide-y">
          {invitationsResult.data.map((invitation) => (
            <li key={invitation.invitationId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{invitation.email}</span>
                <RoleBadge role={invitation.role} />
                <span className="text-muted-foreground text-xs">Expires {formatDate(invitation.expiresAt)}</span>
              </div>
              {viewer && canChangeRole(viewer, null, invitation.role) ? (
                <ConfirmButton
                  label="Revoke"
                  ariaLabel={`Revoke invitation for ${invitation.email}`}
                  prompt={`Revoke the invitation for ${invitation.email}?`}
                  confirmLabel="Confirm revoke"
                  disabled={busy}
                  onConfirm={() => {
                    invite.reset();
                    revoke.mutate(invitation.invitationId);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={invite.error ?? revoke.error} />
    </Panel>
  );
}
