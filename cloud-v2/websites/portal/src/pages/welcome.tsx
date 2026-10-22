/**
 * The screens before a workspace, each one centered column:
 *
 *  - the first run (`/` with no workspaces): the person's valid invitations, from a link or addressed to
 *    their verified email, and nothing else; with none they can accept, "Create your workspace". An
 *    invitation that is no longer valid never counts, so it never hides the create card.
 *  - the invitations page (`/invitation`, also where an invitation link lands): every invitation the person
 *    can answer, the link's first, each with Accept and Decline, or "Leave it to join" for someone already in
 *    a workspace, or Switch account when it is for someone else. A link Core says is no longer valid says so
 *    once, with the way on.
 *
 * Accepting opens the workspace joined; creating opens the new one.
 */

import { useQuery } from "@tanstack/react-query";
import {
  buttonVariants,
  Count,
  CreateWorkspaceForm,
  InvitationAcceptCard,
  Spinner,
  workspaceListQuery,
} from "@mentra/workspace-ui";
import { ArrowLeft, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { PendingInvitationCard } from "@/components/pending-invitation";
import { PortalCenteredLayout } from "@/components/portal-shell";
import { safeLocalStorage } from "@/lib/api";
import type { PendingInvitation } from "@/lib/invitations";
import { Link, navigate } from "@/lib/navigation";
import { creationNotice, portalWorkspaceApi, usePortal } from "@/lib/portal";
import { homeWorkspace, recallWorkspace, workspacePath } from "@/lib/routes";

export const GONE_EXPLANATION =
  "It may have expired, been revoked, been replaced by a newer one or already been used. Ask the person who invited you to send a new one.";

/** The workspace `/` would open, if the person has any. */
function useHomeWorkspace() {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const workspaces = list.data;
  const homeId = workspaces ? homeWorkspace(workspaces, recallWorkspace(safeLocalStorage())) : null;
  return { list, home: workspaces?.find(item => item.workspaceId === homeId) ?? null };
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-2xl leading-tight font-semibold">{title}</h1>
      {children ? <p className="text-muted-foreground mx-auto mt-2 max-w-[420px]">{children}</p> : null}
    </div>
  );
}

/** The invitations as cards under "Pending invitations N". */
function InvitationList({ invitations }: { invitations: readonly PendingInvitation[] }) {
  return (
    <section aria-label="Pending invitations" className="mt-8">
      <h2 className="text-muted-foreground mb-3 flex items-center gap-2 px-1 text-sm font-semibold">
        {invitations.length === 1 ? "Pending invitation" : "Pending invitations"}
        <Count>{invitations.length}</Count>
      </h2>
      <div className="space-y-4">
        {invitations.map(invitation => (
          <PendingInvitationCard key={invitation.preview.invitationId} invitation={invitation} />
        ))}
      </div>
    </section>
  );
}

function BackHome({ name, workspaceId }: { name: string; workspaceId: string }) {
  return (
    <Link
      href={workspacePath(workspaceId)}
      className="text-muted-foreground hover:text-foreground mt-7 inline-flex items-center gap-1.5 self-center text-[15px] font-semibold"
    >
      <ArrowLeft className="size-4" />
      Back to {name}
    </Link>
  );
}

/** `/` with no workspaces: the person's invitations, or with none they can accept, "Create your workspace". */
export function WelcomeScreen() {
  const portal = usePortal();
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const invitations = portal.invitations ?? [];
  // Only an invitation this account can accept puts the first run in invitation-only mode; one for
  // another account is shown (with Switch account) above the create card.
  const acceptable = invitations.filter(invitation => !invitation.forOtherAccount);

  if (list.data === undefined) {
    return (
      <PortalCenteredLayout>
        <Heading title="Welcome to Mentra" />
        {list.isError ? (
          <p role="alert" className="rounded-notice bg-error text-error-foreground mt-8 px-4 py-3 text-center text-sm">
            Could not load your workspaces.{" "}
            <button type="button" className="font-semibold underline underline-offset-[3px]" onClick={() => void list.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <div role="status" className="text-muted-foreground mt-8 flex items-center justify-center gap-2.5 text-sm">
            <Spinner /> Loading your workspaces
          </div>
        )}
      </PortalCenteredLayout>
    );
  }

  return (
    <PortalCenteredLayout>
      <Heading title="Welcome to Mentra">
        {acceptable.length > 0
          ? acceptable.length === 1
            ? "You've been invited to join a workspace. Accept to get started."
            : `You've been invited to join ${acceptable.length} workspaces. Accept one to get started.`
          : "Workspaces are how teams work together on Mentra. Create one to get started."}
      </Heading>
      {invitations.length > 0 ? <InvitationList invitations={invitations} /> : null}
      {acceptable.length === 0 ? (
        <div className="mt-8">
          <CreateFirstWorkspace />
        </div>
      ) : null}
    </PortalCenteredLayout>
  );
}

/** `/invitation`: the person's invitations (the link's first), or once, that the link is no longer valid. */
export function InvitationScreen() {
  const portal = usePortal();
  const { link } = portal;
  const { list, home } = useHomeWorkspace();
  const firstRun = list.data !== undefined && list.data.length === 0;

  if (link.status === "gone") {
    return (
      <PortalCenteredLayout>
        <section aria-label="Invitation no longer valid" className="bg-card rounded-card border p-6 text-center sm:p-8">
          <h1 className="text-2xl leading-tight font-semibold">Invitation no longer valid</h1>
          <p className="text-muted-foreground mx-auto mt-2 max-w-[420px]">{GONE_EXPLANATION}</p>
          <div className="mt-7 grid">
            {home ? (
              <Link href={workspacePath(home.workspaceId)} className={buttonVariants({ size: "lg" })}>
                Go to {home.name}
              </Link>
            ) : (
              // The first run: create a workspace, or open another invitation.
              <Link href="/" className={buttonVariants({ size: "lg" })}>
                Continue
              </Link>
            )}
          </div>
        </section>
      </PortalCenteredLayout>
    );
  }

  if (link.status === "unavailable") {
    return (
      <PortalCenteredLayout>
        <Heading title="You're invited" />
        <div className="mt-8">
          <InvitationAcceptCard
            load={{ status: "error", error: link.error }}
            onRetry={link.retry}
            onAccept={() => {}}
            onDismiss={() => {
              portal.forgetInvitation({ invitationId: null, token: link.token }, "dismissed");
              navigate("/", { replace: true });
            }}
            accepting={false}
            acceptError={null}
          />
        </div>
        {home ? <BackHome name={home.name} workspaceId={home.workspaceId} /> : null}
      </PortalCenteredLayout>
    );
  }

  const invitations = portal.invitations ?? [];
  if (link.status === "checking" || invitations.length === 0) return null;
  const forOther = invitations.some(invitation => invitation.forOtherAccount);
  return (
    <PortalCenteredLayout>
      {forOther && invitations.length === 1 ? (
        <Heading title="Switch accounts to accept">This invitation was sent to a different email address.</Heading>
      ) : firstRun ? (
        <Heading title="Welcome to Mentra">
          {invitations.length === 1 ? "Join the workspace you were invited to." : "Join one of the workspaces you were invited to."}
        </Heading>
      ) : (
        <Heading title={invitations.length === 1 ? "You're invited" : "Your invitations"}>
          {home
            ? `You belong to one workspace at a time. Leave ${home.name} in Settings to join another.`
            : "Accept to join the workspace with the account you're signed in with."}
        </Heading>
      )}
      <InvitationList invitations={invitations} />
      {home ? <BackHome name={home.name} workspaceId={home.workspaceId} /> : null}
    </PortalCenteredLayout>
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
