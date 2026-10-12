/**
 * Acting on one pending invitation (lib/invitations), wherever the portal offers it: as a card on the
 * first run and on `/invitation`, and as an entry in the workspace switcher.
 *
 * Accept uses the link's token when the invitation came by this tab's link, its id otherwise; Core runs
 * the same checks either way. Accepting opens the workspace joined. Dismiss stops offering it in this
 * browser. An invitation for another account offers Switch account (the portal's sign-out) instead.
 */

import {
  acceptErrorMessage,
  Button,
  buttonVariants,
  InvitationAcceptCard,
  useAcceptInvitation,
} from "@mentra/workspace-ui";
import type { PendingInvitation } from "@/lib/invitations";
import { Link, navigate } from "@/lib/navigation";
import { portalWorkspaceApi, usePortal } from "@/lib/portal";
import { INVITATION_PATH, workspacePath } from "@/lib/routes";

/** Accept and Dismiss for `invitation`, with what each tells the rest of the portal. */
function useInvitationActions(invitation: PendingInvitation) {
  const portal = usePortal();
  const { preview, token } = invitation;
  const which = { invitationId: preview.invitationId, token };
  const accept = useAcceptInvitation(portalWorkspaceApi, token ? { token } : { invitationId: preview.invitationId }, {
    onAccepted: accepted => {
      portal.forgetInvitation(which, "accepted");
      navigate(workspacePath(accepted.workspaceId), { replace: true });
    },
    onGone: () => portal.forgetInvitation(which, "gone"),
  });
  return {
    accept,
    dismiss() {
      portal.forgetInvitation(which, "dismissed");
      // The invitation page is about this one invitation: once it is dismissed, go home.
      if (window.location.pathname === INVITATION_PATH) navigate("/", { replace: true });
    },
  };
}

/** The invitation as a card: who invited you to what, and Accept (or Switch account) and Dismiss. */
export function PendingInvitationCard({ invitation }: { invitation: PendingInvitation }) {
  const portal = usePortal();
  const { accept, dismiss } = useInvitationActions(invitation);
  return (
    <InvitationAcceptCard
      load={{ status: "ready", preview: invitation.preview }}
      onRetry={() => {}}
      onAccept={() => accept.mutate()}
      onDismiss={dismiss}
      accepting={accept.isPending || accept.isSuccess}
      acceptError={accept.error}
      viewerEmail={portal.accountEmail}
      onSwitchAccount={portal.signOut}
      switchingAccount={portal.signingOut}
    />
  );
}

/**
 * The switcher entry's buttons. Each is a menu item, so the menu's arrow keys reach it. An invitation for
 * another account links to `/invitation`, which explains and offers Switch account.
 */
export function SwitcherInvitationActions({ invitation }: { invitation: PendingInvitation }) {
  const { accept, dismiss } = useInvitationActions(invitation);
  const small = "h-8 px-3.5 text-[13px]";
  if (invitation.forOtherAccount) {
    return (
      <Link href={INVITATION_PATH} role="menuitem" className={buttonVariants({ variant: "secondary", size: "sm", className: small })}>
        Review
      </Link>
    );
  }
  const name = invitation.preview.workspaceName;
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Button type="button" role="menuitem" variant="secondary" size="sm" className={small} aria-label={`Dismiss the invitation to ${name}`} onClick={dismiss}>
          Dismiss
        </Button>
        <Button
          type="button"
          role="menuitem"
          size="sm"
          className={small}
          aria-label={`Accept the invitation to ${name}`}
          disabled={accept.isPending || accept.isSuccess}
          onClick={() => accept.mutate()}
        >
          {accept.isPending || accept.isSuccess ? "Joining…" : "Accept"}
        </Button>
      </div>
      {accept.error ? (
        <p role="alert" className="text-error-foreground text-xs leading-4">
          {acceptErrorMessage(accept.error, invitation.preview.email)}
        </p>
      ) : null}
    </div>
  );
}
