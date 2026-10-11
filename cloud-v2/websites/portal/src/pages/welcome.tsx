/**
 * The screens before a workspace: the first run (`/` with no workspaces) and an invitation link
 * (`/invitation`). Both are one centered column. The invitation this tab holds is shown alone, with
 * Accept and Dismiss: someone who arrives with an invitation is offered that, not a workspace of their
 * own. Accepting opens the workspace joined. Dismissing forgets the invitation, so a person with no
 * workspace then gets the first run's "Create your workspace"; creating opens the new one.
 */

import { useQuery } from "@tanstack/react-query";
import { Count, CreateWorkspaceForm, InvitationAcceptView, Spinner, workspaceListQuery } from "@mentra/workspace-ui";
import { ArrowLeft, UsersRound } from "lucide-react";
import { CenteredLayout } from "@/components/centered-layout";
import { safeLocalStorage } from "@/lib/api";
import { Link, navigate } from "@/lib/navigation";
import { creationNotice, portalWorkspaceApi, usePortal } from "@/lib/portal";
import { homeWorkspace, recallWorkspace, workspacePath } from "@/lib/routes";

export function WelcomeScreen() {
  const portal = usePortal();
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const workspaces = list.data;
  const firstRun = workspaces !== undefined && workspaces.length === 0;
  const homeId = workspaces ? homeWorkspace(workspaces, recallWorkspace(safeLocalStorage())) : null;
  const home = workspaces?.find(item => item.workspaceId === homeId);
  const token = portal.inviteToken;

  return (
    <CenteredLayout>
      <div className="text-center">
        <h1 className="text-2xl leading-tight font-semibold">
          {token && !firstRun ? "You're invited" : "Welcome to Mentra"}
        </h1>
        <p className="text-muted-foreground mx-auto mt-2 max-w-[420px]">
          {firstRun
            ? token
              ? "Join the workspace you were invited to."
              : "Workspaces are how teams work together on Mentra. Create one to get started."
            : token
              ? "Accept to join the workspace with the account you are signed in with."
              : "Your workspaces will open here."}
        </p>
      </div>

      {token ? (
        <section aria-label="Pending invitations" className="mt-8">
          <h2 className="text-muted-foreground mb-3 flex items-center gap-2 px-1 text-sm font-semibold">
            Pending invitation
            <Count>1</Count>
          </h2>
          <InvitationAcceptView
            api={portalWorkspaceApi}
            token={token}
            onAccepted={workspaceId => {
              portal.forgetInvite();
              navigate(workspacePath(workspaceId), { replace: true });
            }}
            onDismiss={() => {
              portal.forgetInvite();
              navigate("/", { replace: true });
            }}
          />
        </section>
      ) : null}

      {workspaces === undefined ? (
        list.isError ? (
          <p role="alert" className="rounded-notice bg-error text-error-foreground mt-8 px-4 py-3 text-center text-sm">
            Could not load your workspaces.{" "}
            <button
              type="button"
              className="font-semibold underline underline-offset-[3px]"
              onClick={() => void list.refetch()}
            >
              Try again
            </button>
          </p>
        ) : (
          <div role="status" className="text-muted-foreground mt-8 flex items-center justify-center gap-2.5 text-sm">
            <Spinner /> Loading your workspaces
          </div>
        )
      ) : firstRun ? (
        // With an invitation pending, the first run is that invitation alone; dismissing it brings this card.
        token ? null : (
          <div className="mt-8">
            <CreateFirstWorkspace />
          </div>
        )
      ) : home ? (
        <Link
          href={workspacePath(home.workspaceId)}
          className="text-muted-foreground hover:text-foreground mt-7 inline-flex items-center gap-1.5 self-center text-[15px] font-semibold"
        >
          <ArrowLeft className="size-4" />
          Back to {home.name}
        </Link>
      ) : null}
    </CenteredLayout>
  );
}

/** The centered "Create your workspace" card of the first run. */
function CreateFirstWorkspace() {
  const portal = usePortal();
  const notice = creationNotice(portal.creation);
  return (
    <section aria-label="Create your workspace" className="bg-card rounded-card border p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <div className="bg-info text-info-foreground flex size-12 shrink-0 items-center justify-center rounded-[14px]">
          <UsersRound className="size-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-xl leading-tight font-semibold">Create your workspace</h2>
          <p className="text-muted-foreground mt-1.5 text-[15px]">
            Invite your team and give each person the right role. You will be the workspace's owner.
          </p>
        </div>
      </div>
      <div className="mt-6">
        {portal.creation.allowed ? (
          <CreateWorkspaceForm
            api={portalWorkspaceApi}
            wide
            onCreated={created => navigate(workspacePath(created.workspaceId), { replace: true })}
          />
        ) : (
          <p className="rounded-notice bg-surface px-4 py-3 text-sm">
            {notice} Open an invitation link someone sent you to join their workspace.
          </p>
        )}
      </div>
    </section>
  );
}
