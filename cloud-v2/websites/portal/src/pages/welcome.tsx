/**
 * The screens before a workspace: the first run (`/` with no workspaces) and an invitation link
 * (`/invitation`). Both are one centered column. The invitation this tab holds comes first, with Accept;
 * a person with no workspace also gets "Create your workspace" under it. Accepting opens the workspace
 * joined; creating opens the new one.
 */

import { useQuery } from "@tanstack/react-query";
import { CreateWorkspaceForm, InvitationAcceptView, workspaceListQuery } from "@mentra/workspace-ui";
import { ArrowLeft, Loader2, UsersRound } from "lucide-react";
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
        <h1 className="font-display text-[28px] font-bold leading-9 tracking-[-0.6px]">
          {token && !firstRun ? "You're invited" : "Welcome to Mentra"}
        </h1>
        <p className="mx-auto mt-1.5 max-w-[420px] text-[14px] leading-6 text-[#68746d]">
          {firstRun
            ? token
              ? "Join the workspace you were invited to, or create your own."
              : "Workspaces are how teams work together on Mentra. Create one to get started."
            : token
              ? "Accept to join the workspace with the account you are signed in with."
              : "Your workspaces will open here."}
        </p>
      </div>

      {token ? (
        <section aria-label="Pending invitations" className="mt-7">
          <h2 className="mb-2.5 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8d95]">
            Pending invitation
            <span className="rounded-full bg-[#e9f8f1] px-1.5 py-0.5 text-[10px] text-[#087d50]">1</span>
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
          <p role="alert" className="mt-8 rounded-[14px] bg-[#fff3f1] px-4 py-3 text-center text-sm text-[#a64235]">
            Could not load your workspaces.{" "}
            <button type="button" className="font-semibold underline" onClick={() => void list.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <div role="status" className="mt-8 flex items-center justify-center gap-2 text-sm text-[#68746d]">
            <Loader2 className="size-4 animate-spin" /> Loading your workspaces
          </div>
        )
      ) : firstRun ? (
        <>
          {token ? <OrDivider /> : <div className="h-7" />}
          <CreateFirstWorkspace />
        </>
      ) : home ? (
        <Link
          href={workspacePath(home.workspaceId)}
          className="mt-6 inline-flex items-center gap-1.5 self-center text-sm font-medium text-[#5d6068] hover:text-[#14151b]"
        >
          <ArrowLeft className="size-4" />
          Back to {home.name}
        </Link>
      ) : null}
    </CenteredLayout>
  );
}

function OrDivider() {
  return (
    <div className="my-5 flex items-center gap-3 text-xs font-medium uppercase tracking-[0.08em] text-[#a0a3aa]">
      <span className="h-px flex-1 bg-[#e0e4de]" />
      or
      <span className="h-px flex-1 bg-[#e0e4de]" />
    </div>
  );
}

/** The centered "Create your workspace" card of the first run. */
function CreateFirstWorkspace() {
  const portal = usePortal();
  const notice = creationNotice(portal.creation);
  return (
    <section
      aria-label="Create your workspace"
      className="rounded-[20px] border border-[#e0e4de] bg-white/95 p-6 shadow-[0_16px_40px_-8px_rgba(20,20,26,0.08)]"
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-[#e9f8f1] text-[#087d50]">
          <UsersRound className="size-5" />
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-[20px] font-bold leading-7 tracking-[-0.3px]">Create your workspace</h2>
          <p className="mt-1 text-sm leading-6 text-[#68746d]">
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
          <p className="rounded-[14px] bg-[#f5f7f4] p-4 text-sm leading-6 text-[#4f5d54]">
            {notice} Open an invitation link someone sent you to join their workspace.
          </p>
        )}
      </div>
    </section>
  );
}
