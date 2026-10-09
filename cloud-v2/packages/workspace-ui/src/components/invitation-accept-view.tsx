/**
 * What an invitation link opens: who invited you to what, and a button to accept.
 *
 * The invitation is looked up by POST (the token travels in the body), and the token is never
 * rendered. Accepting needs a signed-in person whose verified email is the invited address; when that
 * is not the case the server's own explanation is shown.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvitationPreview, WorkspaceApi } from "../api";
import { WorkspaceApiError } from "../errors";
import { invitationPreviewQuery, workspaceKeys } from "../queries";
import { ROLE_LABELS } from "../roles";
import { Button } from "../ui/button";
import { ErrorNotice, Loading, LoadError, Panel, Restricted } from "./common";

export function InvitationAcceptView({
  api,
  token,
  onAccepted,
}: {
  api: WorkspaceApi;
  token: string;
  onAccepted(workspaceId: string): void;
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
  accepting,
  acceptError,
}: {
  load: InvitationLoad;
  onRetry(): void;
  onAccept(): void;
  accepting: boolean;
  acceptError: unknown;
}) {
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
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </Panel>
      );
    }
    if (error instanceof WorkspaceApiError && (error.status === 404 || error.status === 410)) {
      return (
        <Panel title="Invitation">
          <p className="text-sm font-medium">This invitation is no longer valid.</p>
          <Restricted>
            It may have expired, been revoked or already been used. Ask the person who invited you to send a new one.
          </Restricted>
        </Panel>
      );
    }
    return (
      <Panel title="Invitation">
        <LoadError error={error} onRetry={onRetry} />
      </Panel>
    );
  }

  const { workspaceName, email, role } = load.preview;
  return (
    <Panel title={`Join ${workspaceName}`}>
      <p className="text-sm">
        You have been invited to join <strong>{workspaceName}</strong> as {ROLE_LABELS[role]}.
      </p>
      <p className="text-muted-foreground text-sm">
        This invitation was sent to <strong>{email}</strong>. You need to be signed in with that verified address to
        accept it.
      </p>
      <Button type="button" disabled={accepting} onClick={onAccept}>
        Accept invitation
      </Button>
      <ErrorNotice error={acceptError} />
    </Panel>
  );
}
