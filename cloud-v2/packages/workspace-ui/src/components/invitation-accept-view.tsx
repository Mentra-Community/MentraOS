/**
 * What an invitation link opens: who invited you to what, and a button to accept.
 *
 * The invitation is looked up by POST (the token travels in the body), and the token is never
 * rendered. Accepting needs a signed-in person whose verified email is the invited address; when that
 * is not the case the server's own explanation is shown.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailIcon } from "lucide-react";
import type { InvitationPreview, WorkspaceApi } from "../api";
import { WorkspaceApiError } from "../errors";
import { invitationPreviewQuery, workspaceKeys } from "../queries";
import { ROLE_LABELS } from "../roles";
import { Button } from "../ui/button";
import { ErrorNotice, Loading, LoadError, Panel, Restricted, WorkspaceAvatar } from "./common";

export function InvitationAcceptView({
  api,
  token,
  onAccepted,
  onDismiss,
}: {
  api: WorkspaceApi;
  token: string;
  onAccepted(workspaceId: string): void;
  /** Offer Dismiss: the host forgets the invitation. Accepting stays possible from the link. */
  onDismiss?(): void;
}) {
  const client = useQueryClient();
  const preview = useQuery(invitationPreviewQuery(api, token));
  const accept = useMutation({
    mutationFn: () => api.acceptInvitation(token),
    gcTime: 0,
    onSuccess: async (accepted) => {
      // The new membership changes the caller's workspace list.
      await client.invalidateQueries({ queryKey: workspaceKeys.list(api) });
      onAccepted(accepted.workspaceId);
    },
  });

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
}: {
  load: InvitationLoad;
  onRetry(): void;
  onAccept(): void;
  onDismiss?(): void;
  accepting: boolean;
  acceptError: unknown;
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
    if (error instanceof WorkspaceApiError && (error.status === 404 || error.status === 410)) {
      return (
        <Panel title="Invitation">
          <p className="text-[15px] font-semibold">This invitation is no longer valid.</p>
          <Restricted>
            It may have expired, been revoked or already been used. Ask the person who invited you to send a new one.
          </Restricted>
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

  const { workspaceName, email, role } = load.preview;
  return (
    <section
      role="region"
      aria-label={`Join ${workspaceName}`}
      className="bg-card text-card-foreground rounded-card border p-6 sm:p-8"
    >
      <div className="flex items-start gap-4">
        <WorkspaceAvatar name={workspaceName} className="size-12 text-lg" />
        <div className="min-w-0 space-y-1">
          <h2 className="text-xl leading-tight font-semibold">Join {workspaceName}</h2>
          <p className="text-[15px]">
            You have been invited to join <strong className="font-semibold">{workspaceName}</strong> as{" "}
            {ROLE_LABELS[role]}.
          </p>
        </div>
      </div>
      <p className="rounded-notice bg-surface text-muted-foreground mt-6 flex items-start gap-2.5 px-4 py-3 text-sm">
        <MailIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          This invitation was sent to <strong className="text-foreground font-semibold">{email}</strong>. You need to be
          signed in with that verified address to accept it.
        </span>
      </p>
      {/* As on the sign-in page's consent screen: the way out, then the action, as equal pills. */}
      <div className={onDismiss ? "mt-6 grid grid-cols-2 gap-2.5" : "mt-6 grid"}>
        {onDismiss ? (
          <Button type="button" variant="secondary" size="lg" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
        <Button type="button" size="lg" disabled={accepting} onClick={onAccept}>
          {accepting ? "Joining…" : "Accept invitation"}
        </Button>
      </div>
      <div className="mt-4 empty:hidden">
        <ErrorNotice error={acceptError} />
      </div>
    </section>
  );
}
