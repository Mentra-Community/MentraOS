/**
 * Invitations: invite by email, and the pending invitations with Resend and Revoke.
 *
 * Three ways to show them: `WorkspaceInvitationsPanel` (the form and the list in one card),
 * `WorkspaceInviteDialog` (the form in a dialog) and `WorkspacePendingInvitationsPanel` (the list alone,
 * under a member list). Resend sends the same address a new invitation with the same role; Core
 * supersedes the pending one, so only the newest link works.
 *
 * The invitation link carries the only copy of its token, so after an invitation is sent the link lives
 * in component state until it is dismissed. It is never put in the query cache.
 */

import { useQuery } from "@tanstack/react-query";
import {
  canChangeRole,
  type InvitationView,
  type WorkspaceDetail,
  type WorkspaceRole,
} from "@mentra/workspace-contract";
import { CheckIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { WorkspaceApi } from "../api";
import { formatDate } from "../lib/format";
import { cn } from "../lib/utils";
import { invitationsQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { assignableRoles, can, effectiveRole, ROLE_DESCRIPTIONS, ROLE_LABELS } from "../roles";
import { licenseStrings } from "../strings/licenses";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { Avatar, CopyButton, ErrorNotice, Panel, QueryGate, Restricted, RoleBadge } from "./common";
import { ConfirmDialog, useAsking } from "./confirm-dialog";

const TITLE = "Invitations";
const DESCRIPTION = "Invite people by email. An invitation can only be accepted by the address it was sent to.";

export interface InvitationLink {
  email: string;
  role: WorkspaceRole;
  inviteUrl: string;
  /** A new invitation that replaced a pending one: the earlier link stopped working. */
  resent?: boolean;
}

// --- Pieces ------------------------------------------------------------------

/** The link of an invitation just sent, with Copy and Dismiss. Shown whatever state the queries are in. */
function InvitationLinkNotice({ link, onDismiss }: { link: InvitationLink; onDismiss?(): void }) {
  return (
    <div role="status" className="rounded-notice bg-surface space-y-3 p-4 text-sm">
      <p>
        {link.resent ? "A new invitation was sent to " : "Invitation sent to "}
        <strong>{link.email}</strong> as {ROLE_LABELS[link.role]}.{" "}
        {link.resent ? "The earlier link no longer works. " : ""}If the email does not arrive, share this link. It only
        works for someone signed in with that address.
      </p>
      <code className="bg-background block rounded-[10px] border px-3 py-2.5 font-mono text-xs break-all select-all">
        {link.inviteUrl}
      </code>
      <div className="flex gap-2">
        <CopyButton text={link.inviteUrl} label="Copy link" />
        {onDismiss ? (
          <Button type="button" variant="secondary" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Email, role and Send. `stacked` lays it out for a dialog: full-width fields, the role explained, buttons last. */
function InviteForm({
  api,
  workspaceId,
  detail,
  onSent,
  onCancel,
  stacked = false,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  detail: WorkspaceDetail;
  onSent(link: InvitationLink): void;
  onCancel?(): void;
  stacked?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const emailId = useId();
  const roleId = useId();
  const invite = useWorkspaceMutation(api, workspaceId, async (input: { email: string; role: WorkspaceRole }) => {
    const created = await api.createInvitation(workspaceId, input);
    onSent({ email: input.email, role: input.role, inviteUrl: created.inviteUrl });
    return created.invitationId;
  });

  const invitable = assignableRoles(effectiveRole(detail), null);
  const selectedRole = invitable.includes(role) ? role : (invitable[0] ?? "member");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    invite.mutate({ email: address, role: selectedRole }, { onSuccess: () => setEmail("") });
  }

  const sendButton = (
    <Button type="submit" disabled={invite.isPending || email.trim() === ""}>
      {invite.isPending ? "Sending…" : "Send invitation"}
    </Button>
  );

  return (
    <form onSubmit={submit} className={cn(stacked ? "space-y-4" : "flex flex-wrap items-end gap-3")}>
      <div className="grid gap-2">
        <Label htmlFor={emailId}>Email address</Label>
        <Input
          id={emailId}
          type="email"
          required
          autoFocus={stacked}
          autoComplete="off"
          placeholder="teammate@example.com"
          className={cn(!stacked && "w-72")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={roleId}>Role</Label>
        <NativeSelect
          id={roleId}
          aria-label="Invitation role"
          className={cn(stacked && "w-full")}
          value={selectedRole}
          onChange={(event) => setRole(event.target.value as WorkspaceRole)}
        >
          {invitable.map((option) => (
            <option key={option} value={option}>
              {ROLE_LABELS[option]}
            </option>
          ))}
        </NativeSelect>
        {stacked ? <p className="text-muted-foreground text-sm">{ROLE_DESCRIPTIONS[selectedRole]}</p> : null}
      </div>
      {stacked ? (
        <>
          <ErrorNotice error={invite.error} />
          <div className="flex justify-end gap-2.5 pt-2">
            {onCancel ? (
              <Button type="button" variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            {sendButton}
          </div>
        </>
      ) : (
        <>
          {sendButton}
          <div className="basis-full empty:hidden">
            <ErrorNotice error={invite.error} />
          </div>
        </>
      )}
    </form>
  );
}

/**
 * The pending invitations, each with Resend and Revoke where the viewer could have sent it. Revoke asks in a dialog,
 * which shows a refusal itself; a failed Resend is shown under the list.
 */
function PendingInvitationsList({
  api,
  workspaceId,
  detail,
  invitations,
  onResent,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  detail: WorkspaceDetail;
  invitations: InvitationView[];
  onResent(link: InvitationLink): void;
}) {
  const viewer = effectiveRole(detail);
  const resend = useWorkspaceMutation(api, workspaceId, async (invitation: InvitationView) => {
    const created = await api.createInvitation(workspaceId, { email: invitation.email, role: invitation.role });
    onResent({ email: invitation.email, role: invitation.role, inviteUrl: created.inviteUrl, resent: true });
    return created.invitationId;
  });
  const revoke = useWorkspaceMutation(api, workspaceId, (invitationId: string) =>
    api.revokeInvitation(workspaceId, invitationId),
  );
  const busy = resend.isPending || revoke.isPending;
  const ask = useAsking<InvitationView>((invitation) => invitation.invitationId, busy);
  // The invitations the viewer may resend or revoke: the ones with buttons, which focus moves between.
  const manageable = viewer ? invitations.filter((invitation) => canChangeRole(viewer, null, invitation.role)) : [];
  const asking = ask.asking;
  const t = licenseStrings.confirm;

  if (invitations.length === 0) return <Restricted>No pending invitations.</Restricted>;
  return (
    <>
      <ul className="divide-y">
        {invitations.map((invitation) => (
          <li
            key={invitation.invitationId}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 items-center gap-3">
              <Avatar label={invitation.email} className="text-muted-foreground bg-background border-dashed" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="truncate text-[15px] font-semibold">{invitation.email}</span>
                  <RoleBadge role={invitation.role} />
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">Expires {formatDate(invitation.expiresAt)}</div>
              </div>
            </div>
            {viewer && canChangeRole(viewer, null, invitation.role) ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={`Resend invitation to ${invitation.email}`}
                  title="Sends a new link. The earlier link stops working."
                  disabled={busy}
                  onClick={() => resend.mutate(invitation)}
                >
                  Resend
                </Button>
                <Button
                  ref={ask.trigger(invitation.invitationId)}
                  type="button"
                  variant="destructive-secondary"
                  size="sm"
                  aria-label={`Revoke invitation for ${invitation.email}`}
                  disabled={busy}
                  onClick={() => ask.ask(invitation, manageable)}
                >
                  Revoke
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorNotice error={resend.error} />
      {asking ? (
        <ConfirmDialog
          title={t.revokeInvitation.title(asking.email)}
          description={t.revokeInvitation.body}
          cancelLabel={t.cancel}
          confirmLabel={t.revokeInvitation.action}
          onConfirm={async () => {
            resend.reset();
            await revoke.mutateAsync(asking.invitationId);
            return null;
          }}
          onClose={ask.close}
        />
      ) : null}
    </>
  );
}

// --- The invitations panel: form and list -------------------------------------

export function WorkspaceInvitationsPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
  // Keyed by workspace so a link shown for one workspace is never carried over to another. The screen's
  // test-only props are not passed through: only `api` and `workspaceId` reach it.
  return <InvitationsScreen key={workspaceId} api={api} workspaceId={workspaceId} />;
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
  const [link, setLink] = useState<InvitationLink | null>(initialLink);

  return (
    <Panel title={TITLE} description={DESCRIPTION}>
      {/* The link is the only copy of its token: it is shown whatever state the queries are in. */}
      {link ? <InvitationLinkNotice link={link} onDismiss={() => setLink(null)} /> : null}

      <QueryGate result={detailResult}>
        {(detail) =>
          !can(detail, "workspace.members.manage") ? (
            <Restricted>Only workspace admins can manage invitations.</Restricted>
          ) : (
            <>
              <InviteForm api={api} workspaceId={workspaceId} detail={detail} onSent={setLink} />
              <QueryGate result={invitationsResult}>
                {(invitations) => (
                  <PendingInvitationsList
                    api={api}
                    workspaceId={workspaceId}
                    detail={detail}
                    invitations={invitations}
                    onResent={setLink}
                  />
                )}
              </QueryGate>
            </>
          )
        }
      </QueryGate>
    </Panel>
  );
}

// --- Pending invitations alone, under a member list ---------------------------

/**
 * The workspace's pending invitations with Resend and Revoke, for a page that invites through
 * `WorkspaceInviteDialog`. Renders nothing for a viewer who cannot manage members, or when nothing is
 * pending and no link is waiting to be copied.
 */
export function WorkspacePendingInvitationsPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
  return <PendingInvitationsScreen key={workspaceId} api={api} workspaceId={workspaceId} />;
}

/** The panel itself. `initialLink` is for tests, as on `InvitationsScreen`. */
export function PendingInvitationsScreen({
  api,
  workspaceId,
  initialLink = null,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  initialLink?: InvitationLink | null;
}) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const mayManage = can(detailResult.data, "workspace.members.manage");
  const invitationsResult = useQuery({ ...invitationsQuery(api, workspaceId), enabled: mayManage });
  const [link, setLink] = useState<InvitationLink | null>(initialLink);
  const detail = detailResult.data;

  if (!detail || !mayManage) return null;
  if (!link && invitationsResult.data?.length === 0) return null;
  return (
    <Panel
      title="Pending invitations"
      count={invitationsResult.data?.length}
      description="Sent but not accepted yet. Each can only be accepted by the address it was sent to."
    >
      {link ? <InvitationLinkNotice link={link} onDismiss={() => setLink(null)} /> : null}
      <QueryGate result={invitationsResult}>
        {(invitations) => (
          <PendingInvitationsList
            api={api}
            workspaceId={workspaceId}
            detail={detail}
            invitations={invitations}
            onResent={setLink}
          />
        )}
      </QueryGate>
    </Panel>
  );
}

// --- The invite dialog --------------------------------------------------------

/** "Invite" as a dialog: email and role. After sending, it shows the link once, with Copy. */
export function WorkspaceInviteDialog({
  api,
  workspaceId,
  open,
  onClose,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  open: boolean;
  onClose(): void;
}) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const name = detailResult.data?.name;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={name ? `Invite people to ${name}` : "Invite people"}
      description="They get an email with a link. Only someone signed in with that address can accept it."
    >
      <InviteDialogBody key={workspaceId} api={api} workspaceId={workspaceId} onClose={onClose} />
    </Dialog>
  );
}

/** The dialog's content. `initialLink` is for tests, as on `InvitationsScreen`. */
export function InviteDialogBody({
  api,
  workspaceId,
  onClose,
  initialLink = null,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  onClose(): void;
  initialLink?: InvitationLink | null;
}) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const [link, setLink] = useState<InvitationLink | null>(initialLink);

  if (link) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2.5 text-[15px] font-semibold">
          <span className="bg-info text-info-foreground inline-flex size-7 items-center justify-center rounded-full">
            <CheckIcon className="size-4" />
          </span>
          Invitation sent
        </div>
        <InvitationLinkNotice link={link} />
        <div className="flex justify-end gap-2.5 pt-2">
          <Button type="button" variant="secondary" onClick={() => setLink(null)}>
            Invite someone else
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }
  return (
    <QueryGate result={detailResult}>
      {(detail) =>
        !can(detail, "workspace.members.manage") ? (
          <Restricted>Only workspace admins can invite people.</Restricted>
        ) : (
          <InviteForm api={api} workspaceId={workspaceId} detail={detail} onSent={setLink} onCancel={onClose} stacked />
        )
      }
    </QueryGate>
  );
}
