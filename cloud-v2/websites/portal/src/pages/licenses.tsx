/**
 * Licenses & Billing in one workspace: `/w/<workspaceId>/licenses`.
 *
 * The licenses part is the shared panel (`@mentra/workspace-ui`): the workspace's licenses and who holds
 * each seat, as the viewer's role lets them see it. Below it, where the person is offered the billing
 * module, is the module itself: buying more, changing or cancelling, payment details and invoices. The
 * portal knows nothing of how the module does that; it hosts the module's screen and tells it the scope.
 */

import type { ReactElement } from "react";
import { WorkspaceLicensesPanel } from "@mentra/workspace-ui";
import { PortalModuleHost } from "@/components/portal-module-host";
import type { PortalMe } from "@/lib/api";
import { portalWorkspaceApi } from "@/lib/portal";

/** The billing module for one workspace, or nothing where the person is not offered billing. */
export function billingPart(me: PortalMe, workspaceId: string): ReactElement | null {
  if (!me.modules.billing) return null;
  return <PortalModuleHost module="billing" me={me} scope={{ kind: "workspace", workspaceId }} />;
}

export function LicensesScreen({ workspaceId, me }: { workspaceId: string; me: PortalMe }) {
  return (
    <div className="space-y-6">
      <WorkspaceLicensesPanel api={portalWorkspaceApi} workspaceId={workspaceId} />
      {billingPart(me, workspaceId)}
    </div>
  );
}
