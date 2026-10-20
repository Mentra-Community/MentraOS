/**
 * What every screen of the workspace portal shares: Core's workspace API at `/api/portal/workspaces`
 * (which this portal's session authenticates), the signed-in person, the invitations they can act on,
 * and the Developer Console the sidebar links to.
 */

import type { QueryClient } from "@tanstack/react-query";
import { createWorkspaceApi } from "@mentra/workspace-ui";
import { createContext, useContext } from "react";
import type { PortalModules } from "./api";
import type { LinkInvitation, PendingInvitation } from "./invitations";

/** Core's workspace API, reached with this portal's session. */
export const portalWorkspaceApi = createWorkspaceApi({ basePath: "/api/portal/workspaces" });

/**
 * The Mentra Miniapp Store holds a workspace from deletion while it owns any miniapp, a draft included
 * (the settings screen then says how many, instead of offering the delete). While nothing holds the
 * workspace, the page still states the rule.
 */
export const STORE_DELETE_NOTICE =
  "A workspace that owns miniapps in the Mentra Miniapp Store can't be deleted. Delete its miniapps first.";

/** The query that holds who is signed in (`GET /api/portal/me`). While it fails, the portal shows the sign-in page. */
export const PORTAL_ME_KEY = ["portal-me"] as const;

/**
 * The session has ended (a portal module's API answered 401). Asking who the person is again finds out: the
 * answer is a 401 too, and the portal sends them to sign in. A session that is in fact still good just
 * refreshes the answer, so nothing is lost by a module that was wrong.
 */
export function expireSession(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: PORTAL_ME_KEY });
}

/** Whether this person may create a workspace, as `/api/portal/me` reports it. */
export interface WorkspaceCreation {
  allowed: boolean;
  reason: "email_unverified" | "organization_admins_only" | "not_a_person" | null;
}

/** Why "Create workspace" is not offered, in words; null when it is. */
export function creationNotice(creation: WorkspaceCreation): string | null {
  if (creation.allowed) return null;
  if (creation.reason === "email_unverified") return "Verify your account's email address to create a workspace.";
  if (creation.reason === "organization_admins_only") return "On this deployment, workspaces are created by its administrators.";
  return "You can't create a workspace with this account.";
}

export interface PortalSession {
  /** The signed-in person, for display ("Signed in" when Core has no address for them). */
  userEmail: string;
  /** The signed-in person's email address as Core has it, or null: what an invitation is matched against. */
  accountEmail: string | null;
  creation: WorkspaceCreation;
  /** The invitation link this tab holds (lib/workspace-invite), once looked up. */
  link: LinkInvitation;
  /**
   * The valid invitations the person can act on: the link's and those addressed to their verified email,
   * each once, dismissed ones left out (lib/invitations). Undefined while they are being looked up.
   */
  invitations: PendingInvitation[] | undefined;
  /**
   * Stop offering an invitation: it was accepted, dismissed (remembered in this browser), or Core said it
   * is no longer valid. Forgets this tab's link when it is that invitation's.
   */
  forgetInvitation(invitation: { invitationId: string | null; token: string | null }, reason: "accepted" | "dismissed" | "gone"): void;
  signOut(): void;
  signingOut: boolean;
  /** This environment's Developer Console (lib/config), linked from the sidebar; null where there is none. */
  developerConsoleUrl: string | null;
  /** Which portal modules this person is offered (`/api/portal/me`). Nothing of a module shows where it is false. */
  modules: PortalModules;
  /** A portal module's API answered 401: the person's session has ended (see {@link expireSession}). */
  sessionExpired(): void;
}

const PortalContext = createContext<PortalSession | null>(null);

export const PortalProvider = PortalContext.Provider;

export function usePortal(): PortalSession {
  const session = useContext(PortalContext);
  if (!session) throw new Error("usePortal needs a PortalProvider");
  return session;
}
