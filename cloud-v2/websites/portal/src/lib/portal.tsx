/**
 * What every screen of the workspace portal shares: Core's workspace API at `/api/portal/workspaces`
 * (which this portal's session authenticates), the signed-in person, the invitations they can act on,
 * and the Developer Console the sidebar links to.
 */

import { createWorkspaceApi } from "@mentra/workspace-ui";
import { createContext, useContext } from "react";
import type { LinkInvitation, PendingInvitation } from "./invitations";

/** Core's workspace API, reached with this portal's session. */
export const portalWorkspaceApi = createWorkspaceApi({ basePath: "/api/portal/workspaces" });

/**
 * The Mentra Miniapp Store holds a workspace from deletion while it owns published miniapps (the settings
 * screen says so instead of offering the delete). Whatever the workspace still has there when it is
 * deleted (miniapps that are not published, or published ones the Store had not held it for) stays, so
 * the page says what happens to it.
 */
export const STORE_DELETE_NOTICE =
  "Miniapps this workspace still has in the Mentra Miniapp Store stay there, and nobody can manage them until a Store operator assigns them to another workspace.";

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
}

const PortalContext = createContext<PortalSession | null>(null);

export const PortalProvider = PortalContext.Provider;

export function usePortal(): PortalSession {
  const session = useContext(PortalContext);
  if (!session) throw new Error("usePortal needs a PortalProvider");
  return session;
}
