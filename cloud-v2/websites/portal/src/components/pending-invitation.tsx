/**
 * Acting on one pending invitation (lib/invitations), wherever the portal offers it: as a card on the
 * first run and on `/invitation`.
 *
 * Accept uses the link's token when the invitation came by this tab's link, its id otherwise; Core runs
 * the same checks either way. Accepting opens the workspace joined, at the address the person is on. Dismiss stops offering it in this
 * browser. An invitation for another account offers Switch account (the portal's sign-out) instead.
 */

import { InvitationAcceptCard, useAcceptInvitation, workspaceKeys } from "@mentra/workspace-ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PendingInvitation } from "@/lib/invitations";
import { navigate } from "@/lib/navigation";
import { portalWorkspaceApi, usePortal } from "@/lib/portal";
import { INVITATION_PATH, joinedAddress } from "@/lib/routes";

/** Accept and Dismiss for `invitation`, with what each tells the rest of the portal. */
function useInvitationActions(invitation: PendingInvitation) {
  const portal = usePortal();
  const { preview, token } = invitation;
  const which = { invitationId: preview.invitationId, token };
  const accept = useAcceptInvitation(portalWorkspaceApi, token ? { token } : { invitationId: preview.invitationId }, {
    onAccepted: accepted => {
      portal.forgetInvitation(which, "accepted");
      // The joined workspace opens at the address the person is on, with the rest of its query (`?buy=`) kept.
      navigate(joinedAddress(window.location.pathname, window.location.search, accepted.workspaceId, window.location.hash), { replace: true });
    },
    onGone: () => portal.forgetInvitation(which, "gone"),
  });
  const client = useQueryClient();
  // Decline turns it down on the server; it then no longer lists, here or in the Mentra App.
  const decline = useMutation({
    mutationFn: () => portalWorkspaceApi.declineInvitation(preview.invitationId),
    gcTime: 0,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: workspaceKeys.myInvitations(portalWorkspaceApi) });
      portal.forgetInvitation(which, "gone");
      if (window.location.pathname === INVITATION_PATH) navigate("/", { replace: true });
    },
  });
  return {
    accept,
    decline,
    dismiss() {
      portal.forgetInvitation(which, "dismissed");
      // The invitation page is about this one invitation: once it is dismissed, go home.
      if (window.location.pathname === INVITATION_PATH) navigate("/", { replace: true });
    },
  };
}

/**
 * The invitation as a card: who invited you to what, when it expires, and Accept (or Switch account), Decline
 * and Dismiss. A person may belong to several workspaces, so someone already in one accepts as anyone else does:
 * joining adds the workspace beside theirs.
 */
export function PendingInvitationCard({ invitation }: { invitation: PendingInvitation }) {
  const portal = usePortal();
  const { accept, decline, dismiss } = useInvitationActions(invitation);
  return (
    <InvitationAcceptCard
      load={{ status: "ready", preview: invitation.preview }}
      onRetry={() => {}}
      onAccept={() => accept.mutate()}
      onDismiss={dismiss}
      onDecline={() => decline.mutate()}
      declining={decline.isPending || decline.isSuccess}
      accepting={accept.isPending || accept.isSuccess}
      acceptError={accept.error ?? decline.error}
      viewerEmail={portal.accountEmail}
      onSwitchAccount={portal.signOut}
      switchingAccount={portal.signingOut}
    />
  );
}
