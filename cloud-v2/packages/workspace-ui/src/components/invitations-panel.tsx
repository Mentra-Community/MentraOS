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
import { ConfirmButton, CopyButton, ErrorNotice, Panel, QueryGate, Restricted, RoleBadge } from "./common";

const TITLE = "Invitations";
const DESCRIPTION = "Invite people by email. An invitation can only be accepted by the address it was sent to.";

export interface InvitationLink {
  email: string;
  role: WorkspaceRole;
  inviteUrl: string;
}

export function WorkspaceInvitationsPanel(props: { api: WorkspaceApi; workspaceId: string }) {
  // Keyed by workspace so a link shown for one workspace is never carried over to another.
  return <InvitationsScreen key={props.workspaceId} {...props} />;
}

/**
 * The panel itself. `initialLink` exists so a test can render the state after an invitation was created;
 * the public panel never sets it.
 */
export function InvitationsScreen({
  api,
  workspaceId,
  initialLink = null,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  initialLink?: InvitationLink | null;
}) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const invitationsResult = useQuery({
    ...invitationsQuery(api, workspaceId),
    enabled: can(detailResult.data, "workspace.members.manage"),
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [link, setLink] = useState<InvitationLink | null>(initialLink);
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
  const busy = invite.isPending || revoke.isPending;

  return (
    <Panel title={TITLE} description={DESCRIPTION}>
      {/* The link is the only copy of its token: it is shown whatever state the queries are in. */}
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

      <QueryGate result={detailResult}>
        {(detail) => {
          if (!can(detail, "workspace.members.manage")) {
            return <Restricted>Only workspace admins can manage invitations.</Restricted>;
          }
          const viewer = effectiveRole(detail);
          const invitable = assignableRoles(viewer, null);
          const selectedRole = invitable.includes(role) ? role : (invitable[0] ?? "member");

          function submit(event: FormEvent<HTMLFormElement>) {
            event.preventDefault();
            const address = email.trim();
            if (!address) return;
            revoke.reset();
            invite.mutate({ email: address, role: selectedRole }, { onSuccess: () => setEmail("") });
          }

          return (
            <>
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

              <QueryGate result={invitationsResult}>
                {(invitations) =>
                  invitations.length === 0 ? (
                    <Restricted>No pending invitations.</Restricted>
                  ) : (
                    <ul className="divide-y">
                      {invitations.map((invitation) => (
                        <li
                          key={invitation.invitationId}
                          className="flex flex-wrap items-center justify-between gap-2 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium">{invitation.email}</span>
                            <RoleBadge role={invitation.role} />
                            <span className="text-muted-foreground text-xs">
                              Expires {formatDate(invitation.expiresAt)}
                            </span>
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
                  )
                }
              </QueryGate>
            </>
          );
        }}
      </QueryGate>
      <ErrorNotice error={invite.error ?? revoke.error} />
    </Panel>
  );
}
