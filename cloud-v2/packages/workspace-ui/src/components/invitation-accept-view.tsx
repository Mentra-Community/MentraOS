/**
 * An invitation, as the person invited sees it: who invited them to what, as which role, and Accept.
 *
 * `InvitationAcceptView` is what an invitation link opens: it looks the invitation up by POST (the token
 * travels in the body) and never renders the token. `InvitationAcceptCard` is the same screen without the
 * fetching, for a host that already has the invitation (one of `myInvitationsQuery`, accepted by id).
 *
 * Accepting needs the signed-in person's verified email to be the invited address. When the host says who
 * is signed in (`viewerEmail`) and it is someone else, the card says so up front and offers to switch
 * accounts instead of an Accept the server would refuse.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvitationPreview } from "@mentra/workspace-contract";
import { CircleAlert, MailIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AcceptedInvitation, WorkspaceApi } from "../api";
import { errorMessage, isInvitationGone, WorkspaceApiError } from "../errors";
import { formatDate } from "../lib/format";
import { invitationPreviewQuery, workspaceKeys } from "../queries";
import { ROLE_LABELS } from "../roles";
import { Button } from "../ui/button";
import { Loading, LoadError, Panel, Restricted, WorkspaceAvatar } from "./common";

const GONE_TEXT =
  "It may have expired, been revoked, been replaced by a newer one or already been used. Ask the person who invited you to send a new one.";

const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a?.trim() && !!b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether `preview` is addressed to someone other than `viewerEmail`, the signed-in person (case and
 * surrounding space aside). Unknown on either side is not a mismatch: the server still decides.
 */
export function isInvitationForOtherAccount(
  preview: Pick<InvitationPreview, "email"> | undefined,
  viewerEmail: string | null | undefined,
): boolean {
  const invited = preview?.email?.trim();
  const viewer = viewerEmail?.trim();
  return !!invited && !!viewer && !sameAddress(invited, viewer);
}

/** How an invitation is accepted: by its link's token, or by its id when it is addressed to the viewer. */
export type InvitationRef = { token: string } | { invitationId: string };

/**
 * Accepting an invitation. On success the caller's workspace list and their invitations are refetched
 * before `onAccepted` runs; a refusal that means the invitation is gone for good also calls `onGone`.
 */
export function useAcceptInvitation(
  api: WorkspaceApi,
  ref: InvitationRef,
  handlers: { onAccepted(accepted: AcceptedInvitation): void; onGone?(): void },
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => ("token" in ref ? api.acceptInvitation(ref.token) : api.acceptInvitationById(ref.invitationId)),
    gcTime: 0,
    onSuccess: async (accepted) => {
      // The new membership changes the caller's workspace list, and the invitation is no longer theirs to take.
      await Promise.all([
        client.invalidateQueries({ queryKey: workspaceKeys.list(api) }),
        client.invalidateQueries({ queryKey: workspaceKeys.myInvitations(api) }),
      ]);
      handlers.onAccepted(accepted);
    },
    onError: (error) => {
      if (!isInvitationGone(error)) return;
      void client.invalidateQueries({ queryKey: workspaceKeys.myInvitations(api) });
      handlers.onGone?.();
    },
  });
}

export function InvitationAcceptView({
  api,
  token,
  onAccepted,
  onDismiss,
  viewerEmail,
  onSwitchAccount,
  onGone,
}: {
  api: WorkspaceApi;
  token: string;
  onAccepted(workspaceId: string): void;
  /** Offer Dismiss: the host forgets the invitation. Accepting stays possible from the link. */
  onDismiss?(): void;
  /** Who is signed in, so an invitation for someone else says so instead of offering Accept. */
  viewerEmail?: string | null;
  /** Offer to switch accounts when the invitation is for someone else. */
  onSwitchAccount?(): void;
  /** The server said the invitation can never be accepted (on look-up or on Accept). */
  onGone?(): void;
}) {
  const preview = useQuery(invitationPreviewQuery(api, token));
  const accept = useAcceptInvitation(api, { token }, { onAccepted: (accepted) => onAccepted(accepted.workspaceId), onGone });

  return (
    <InvitationAcceptCard
      load={
        preview.data !== undefined
          ? { status: "ready", preview: preview.data }
          : preview.isError
            ? { status: "error", error: preview.error }
            : { status: "loading" }
      }
      onRetry={() => void preview.refetch()}
      onAccept={() => accept.mutate()}
      onDismiss={onDismiss}
      accepting={accept.isPending || accept.isSuccess}
      acceptError={accept.error}
      viewerEmail={viewerEmail}
      onSwitchAccount={onSwitchAccount}
    />
  );
}

export type InvitationLoad =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; preview: InvitationPreview };

/** The invitation screen without its data fetching. */
export function InvitationAcceptCard({
  load,
  onRetry,
  onAccept,
  onDismiss,
  accepting,
  acceptError,
  viewerEmail,
  onSwitchAccount,
  switchingAccount = false,
}: {
  load: InvitationLoad;
  onRetry(): void;
  onAccept(): void;
  onDismiss?(): void;
  accepting: boolean;
  acceptError: unknown;
  /** Who is signed in. When known and not the invited address, Accept gives way to Switch account. */
  viewerEmail?: string | null;
  onSwitchAccount?(): void;
  switchingAccount?: boolean;
}) {
  const dismiss = onDismiss ? (
    <Button type="button" variant="secondary" size="sm" onClick={onDismiss}>
      Dismiss
    </Button>
  ) : null;

  if (load.status === "loading") {
    return (
      <Panel title="Invitation">
        <Loading />
      </Panel>
    );
  }
  if (load.status === "error") {
    const { error } = load;
    if (error instanceof WorkspaceApiError && error.status === 401) {
      return (
        <Panel title="Invitation">
          <Restricted>Sign in to view this invitation.</Restricted>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
            {dismiss}
          </div>
        </Panel>
      );
    }
    if (isInvitationGone(error)) {
      return (
        <Panel title="Invitation">
          <p className="text-[15px] font-semibold">This invitation is no longer valid.</p>
          <Restricted>{GONE_TEXT}</Restricted>
          {dismiss}
        </Panel>
      );
    }
    return (
      <Panel title="Invitation">
        <LoadError error={error} onRetry={onRetry} />
        {dismiss}
      </Panel>
    );
  }

  const { preview } = load;
  const { workspaceName, email, role } = preview;
  const invitedBy = preview.invitedByEmail?.trim() || null;
  const otherAccount = isInvitationForOtherAccount(preview, viewerEmail);
  const strong = (text: string) => <strong className="font-semibold [overflow-wrap:anywhere]">{text}</strong>;

  let notice: ReactNode;
  if (otherAccount) {
    notice = (
      <p role="status" className="rounded-notice bg-error text-error-foreground mt-6 flex items-start gap-2.5 px-4 py-3 text-sm">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          This invitation is for {strong(email)}. You&apos;re signed in as {strong(viewerEmail!.trim())}.{" "}
          {onSwitchAccount ? "Switch to that account to accept it." : "Sign in with that account to accept it."}
        </span>
      </p>
    );
  } else if (viewerEmail?.trim()) {
    notice = (
      <p className="text-muted-foreground mt-4 text-sm">
        Sent to {email}
        {preview.expiresAt ? ` · Expires ${formatDate(preview.expiresAt)}` : null}
      </p>
    );
  } else {
    notice = (
      <p className="rounded-notice bg-surface text-muted-foreground mt-6 flex items-start gap-2.5 px-4 py-3 text-sm">
        <MailIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          This invitation was sent to <strong className="text-foreground font-semibold">{email}</strong>. You need to be
          signed in with that verified address to accept it.
        </span>
      </p>
    );
  }

  // As on the sign-in page's consent screen: the way out, then the action, as equal pills.
  const actions: ReactNode[] = [];
  if (onDismiss) {
    actions.push(
      <Button key="dismiss" type="button" variant="secondary" size="lg" onClick={onDismiss}>
        Dismiss
      </Button>,
    );
  }
  if (!otherAccount) {
    actions.push(
      <Button key="accept" type="button" size="lg" disabled={accepting} onClick={onAccept}>
        {accepting ? "Joining…" : "Accept invitation"}
      </Button>,
    );
  } else if (onSwitchAccount) {
    actions.push(
      <Button key="switch" type="button" size="lg" disabled={switchingAccount} onClick={onSwitchAccount}>
        {switchingAccount ? "Signing out…" : "Switch account"}
      </Button>,
    );
  }

  return (
    <section
      role="region"
      aria-label={`Join ${workspaceName}`}
      className="bg-card text-card-foreground rounded-card border p-6 sm:p-8"
    >
      <div className="flex items-start gap-4">
        <WorkspaceAvatar name={workspaceName} className="size-12 text-lg" />
        <div className="min-w-0 space-y-1">
          <h2 className="text-xl leading-tight font-semibold [overflow-wrap:anywhere]">Join {workspaceName}</h2>
          <p className="text-[15px]">
            {invitedBy ? (
              <>
                {strong(invitedBy)} invited {otherAccount ? strong(email) : "you"}
              </>
            ) : otherAccount ? (
              <>{strong(email)} has been invited</>
            ) : (
              "You have been invited"
            )}{" "}
            to join {strong(workspaceName)} as {ROLE_LABELS[role]}.
          </p>
        </div>
      </div>
      {notice}
      {actions.length > 0 ? (
        <div className={actions.length === 2 ? "mt-6 grid grid-cols-2 gap-2.5" : "mt-6 grid"}>{actions}</div>
      ) : null}
      {acceptError ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground mt-4 px-4 py-3 text-sm">
          {acceptErrorMessage(acceptError, email)}
        </p>
      ) : null}
    </section>
  );
}

/** Why Accept was refused, in words: the server's own reason, except where a plainer one exists. */
export function acceptErrorMessage(error: unknown, invitedEmail: string): string {
  if (isInvitationGone(error)) return `This invitation is no longer valid. ${GONE_TEXT}`;
  if (error instanceof WorkspaceApiError && error.code === "email_mismatch") {
    return `This invitation is for ${invitedEmail}. To accept it, sign in with that address and make sure it's verified.`;
  }
  if (error instanceof WorkspaceApiError && error.code === "already_member") return "You're already in this workspace.";
  return errorMessage(error);
}
