/**
 * The invitations the portal offers the signed-in person (lib/invitations), and forgetting them.
 *
 * The tab's invitation link is looked up by its token and the person's own invitations listed, once
 * signed in (both need a session). A link Core says is no longer valid is forgotten the moment that
 * answer arrives: its token leaves session storage, so it never counts as pending, never shows in the
 * switcher or on the sign-in screen, and is not looked up again. `/invitation` says so once.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invitationPreviewQuery, isInvitationGone, myInvitationsQuery, workspaceKeys } from "@mentra/workspace-ui";
import { useEffect, useState } from "react";
import { isIndeterminate, pendingInvitations, type LinkInvitation, type UnavailableInvitations } from "./invitations";
import type { PortalSession } from "./portal";
import { portalWorkspaceApi } from "./portal";
import { INVITATION_PATH } from "./routes";
import { dismissedInvitations, forgetPendingInvite, rememberDismissedInvitation, type InviteStorage } from "./workspace-invite";

export function usePortalInvitations(args: {
  /** The token this tab's link left in session storage, if any. */
  initialToken: string | null;
  signedIn: boolean;
  accountEmail: string | null;
  pathname: string;
  /** Session storage, where the link's token is kept. */
  sessionStore: InviteStorage | null;
  /** Local storage, where dismissed invitations are remembered. */
  localStore: InviteStorage | null;
  /** The link's token was forgotten: the host drops any copy it keeps. */
  onTokenForgotten?(): void;
}): Pick<PortalSession, "link" | "invitations" | "forgetInvitation"> & {
  inviteToken: string | null;
  /** Invitations that could not be read, so the first run waits for them (lib/invitations). */
  unavailable: UnavailableInvitations | null;
} {
  const { signedIn, accountEmail, pathname, sessionStore, localStore } = args;
  const qc = useQueryClient();
  const [inviteToken, setInviteToken] = useState<string | null>(args.initialToken);
  // A link Core said is no longer valid, while `/invitation` shows that once. Its token is already gone.
  const [linkGone, setLinkGone] = useState(false);
  const [dismissed, setDismissed] = useState(() => dismissedInvitations(localStore));
  const peek = useQuery({
    ...invitationPreviewQuery(portalWorkspaceApi, inviteToken ?? ""),
    enabled: signedIn && inviteToken !== null,
  });
  const mine = useQuery({ ...myInvitationsQuery(portalWorkspaceApi), enabled: signedIn });

  function forgetLink(gone: boolean) {
    forgetPendingInvite(sessionStore);
    args.onTokenForgotten?.();
    setInviteToken(null);
    // Said once, where the link landed; anywhere else a dead link just stops being offered.
    if (gone) setLinkGone(pathname === INVITATION_PATH);
  }

  const peekGone = inviteToken !== null && peek.isError && isInvitationGone(peek.error);
  useEffect(() => {
    if (peekGone) forgetLink(true);
  }, [peekGone]);

  useEffect(() => {
    if (pathname !== INVITATION_PATH) setLinkGone(false);
  }, [pathname]);

  // A dead link counts as gone from the moment it is looked up, before the effect above forgets it.
  const link: LinkInvitation =
    inviteToken === null || peekGone
      ? linkGone || (peekGone && pathname === INVITATION_PATH)
        ? { status: "gone" }
        : { status: "none" }
      : peek.data
        ? { status: "valid", token: inviteToken, preview: peek.data }
        : peek.isError
          ? { status: "unavailable", token: inviteToken, error: peek.error, retry: () => void peek.refetch() }
          : { status: "checking", token: inviteToken };

  // Neither source is "none" while its failure may pass: a dropped connection or a 5xx. A 4xx is an answer.
  const linkUnreadable = signedIn && link.status === "unavailable" && isIndeterminate(link.error);
  const mineUnreadable = signedIn && mine.isError && isIndeterminate(mine.error);
  const unavailable: UnavailableInvitations | null =
    linkUnreadable || mineUnreadable
      ? {
          error: link.status === "unavailable" && linkUnreadable ? link.error : mine.error,
          token: linkUnreadable && link.status === "unavailable" ? link.token : null,
          retry() {
            if (linkUnreadable) void peek.refetch();
            if (mineUnreadable) void mine.refetch();
          },
        }
      : null;

  return {
    unavailable,
    // The token is never offered once it is known to be dead, even before it is forgotten.
    inviteToken: peekGone ? null : inviteToken,
    link,
    // The person's own invitations count as none when Core will not list them (an unverified email).
    invitations: signedIn ? pendingInvitations({ link, mine: mine.isError ? null : mine.data, dismissed, accountEmail }) : [],
    forgetInvitation(invitation, reason) {
      if (invitation.token !== null && invitation.token === inviteToken) forgetLink(reason === "gone");
      if (reason === "dismissed" && invitation.invitationId) {
        rememberDismissedInvitation(localStore, invitation.invitationId);
        setDismissed(new Set([...dismissed, invitation.invitationId]));
      }
      if (reason === "gone") void qc.invalidateQueries({ queryKey: workspaceKeys.myInvitations(portalWorkspaceApi) });
    },
  };
}
