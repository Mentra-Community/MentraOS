/**
 * Licenses & Billing in one workspace: `/w/<workspaceId>/licenses`.
 *
 * The licenses part is the shared panel (`@mentra/workspace-ui`): the workspace's licenses and who holds
 * each seat, as the viewer's role lets them see it. Below it, where the person is offered the billing
 * module and may manage the workspace's billing (`workspace.billing.manage`: Admins and Owners), is the
 * module itself: buying more, changing or cancelling, payment details and invoices. A member never sees
 * it. The portal knows nothing of how the module does that; it hosts the module's screen and tells it the
 * scope.
 */

import type { ReactElement } from "react";
import type { WorkspaceDetail } from "@mentra/workspace-contract";
import { can, WorkspaceLicensesPanel } from "@mentra/workspace-ui";
import { PortalModuleHost } from "@/components/portal-module-host";
import type { PortalMe } from "@/lib/api";
import { portalWorkspaceApi } from "@/lib/portal";

/** Whether the viewer is shown the workspace's billing: the portal offers the module and their role may manage billing. */
export function billingOffered(me: PortalMe, detail: Pick<WorkspaceDetail, "capabilities"> | undefined): boolean {
  return me.modules.billing && can(detail, "workspace.billing.manage");
}

/** The billing module for one workspace, or nothing where the viewer is not shown billing. */
export function billingPart(me: PortalMe, workspaceId: string, detail: Pick<WorkspaceDetail, "capabilities"> | undefined): ReactElement | null {
  if (!billingOffered(me, detail)) return null;
  return <PortalModuleHost module="billing" me={me} scope={{ kind: "workspace", workspaceId }} />;
}

export function LicensesScreen({ workspaceId, me, detail }: { workspaceId: string; me: PortalMe; detail: WorkspaceDetail }) {
  return (
    <div className="space-y-6">
      <WorkspaceLicensesPanel api={portalWorkspaceApi} workspaceId={workspaceId} />
      {billingPart(me, workspaceId, detail)}
    </div>
  );
}
