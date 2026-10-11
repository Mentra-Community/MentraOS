/**
 * The workspace portal's Workspaces page: the shared Core workspace screens
 * (`@mentra/workspace-ui`) over Core's workspace API at `/api/portal/workspaces`,
 * which this portal's session authenticates.
 *
 * A person sees the workspaces they belong to and acts with their role's
 * rights: creating a workspace (when this deployment lets them), members and
 * roles, invitations, settings and the audit log. An invitation link opens the
 * accept screen here. Every request is checked by Core; the tabs only leave out
 * what the viewer's role cannot use.
 */

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceCapability, WorkspaceDetail } from "@mentra/workspace-contract";
import {
  createWorkspaceApi,
  InvitationAcceptView,
  ROLE_LABELS,
  WorkspaceAuditPanel,
  WorkspaceInvitationsPanel,
  WorkspaceMembersPanel,
  WorkspacePicker,
  WorkspaceSettingsPanel,
  can,
  effectiveRole,
  workspaceDetailQuery,
  workspaceKeys,
  type WorkspaceListItem,
} from "@mentra/workspace-ui";
import { useEffect, useId, useState } from "react";

const PANEL = "rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]";

/** Core's workspace API, reached with this portal's session. */
export const portalWorkspaceApi = createWorkspaceApi({ basePath: "/api/portal/workspaces" });

/**
 * Core deletes a workspace without asking the Mentra Miniapp Store, so the page says what happens to the
 * miniapps the workspace publishes there.
 */
export const STORE_DELETE_NOTICE =
  "Miniapps this workspace publishes in the Mentra Miniapp Store stay published, and nobody can manage them until a Store operator assigns them to another workspace.";

/** Whether this person may create a workspace, as `/api/portal/me` reports it. */
export interface WorkspaceCreation {
  allowed: boolean;
  reason: "email_unverified" | "organization_admins_only" | "not_a_person" | null;
}

type TabKey = "members" | "invitations" | "settings" | "audit";

/** The tabs in order, each with the capability it needs (Settings is for everyone: leaving is there). */
const TABS: ReadonlyArray<{ key: TabKey; label: string; needs: WorkspaceCapability | null }> = [
  { key: "members", label: "Members", needs: "workspace.members.read" },
  { key: "invitations", label: "Invitations", needs: "workspace.members.manage" },
  { key: "settings", label: "Settings", needs: null },
  { key: "audit", label: "Audit log", needs: "workspace.audit.read" },
];

/** The tabs the viewer's capabilities in this workspace open. */
export function visibleTabs(detail: Pick<WorkspaceDetail, "capabilities"> | undefined): TabKey[] {
  return TABS.filter(tab => tab.needs === null || can(detail, tab.needs)).map(tab => tab.key);
}

/** Why "New workspace" is not offered, in words; null when it is. */
export function creationNotice(creation: WorkspaceCreation): string | null {
  if (creation.allowed) return null;
  if (creation.reason === "email_unverified") return "Verify your account's email address to create a workspace.";
  if (creation.reason === "organization_admins_only") return "On this deployment, workspaces are created by its administrators.";
  return null;
}

export function WorkspacesPage({
  creation,
  inviteToken,
  onInviteDone,
}: {
  creation: WorkspaceCreation;
  /** The token of an invitation link that was opened in this tab, if any. */
  inviteToken: string | null;
  /** The invitation was accepted or dismissed: forget it. */
  onInviteDone(): void;
}) {
  const api = portalWorkspaceApi;
  const list = useQuery({ queryKey: workspaceKeys.list(api), queryFn: () => api.listWorkspaces() });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("members");

  // Open the first workspace once the list arrives, and drop a selection that disappeared (left or deleted).
  useEffect(() => {
    const items: WorkspaceListItem[] | undefined = list.data;
    if (!items) return;
    if (workspaceId && items.some(item => item.workspaceId === workspaceId)) return;
    setWorkspaceId(items[0]?.workspaceId ?? null);
  }, [list.data, workspaceId]);

  const notice = creationNotice(creation);

  return (
    <div className="space-y-6">
      {inviteToken ? (
        <section className="space-y-3">
          <InvitationAcceptView
            api={api}
            token={inviteToken}
            onAccepted={acceptedId => {
              setWorkspaceId(acceptedId);
              setTab("members");
              onInviteDone();
            }}
          />
          <button type="button" className="px-1 text-sm font-semibold text-[#68746d] hover:text-[#14151b]" onClick={onInviteDone}>
            Dismiss invitation
          </button>
        </section>
      ) : null}

      <section className={`${PANEL} space-y-3 p-5`}>
        <WorkspacePicker api={api} value={workspaceId} onChange={setWorkspaceId} allowCreate={creation.allowed} />
        {notice ? <p className="text-sm text-[#68746d]">{notice}</p> : null}
      </section>

      {workspaceId ? (
        <OpenWorkspace key={workspaceId} workspaceId={workspaceId} tab={tab} onTab={setTab} onGone={() => setWorkspaceId(null)} />
      ) : list.data && list.data.length === 0 ? (
        <p className="px-1 text-sm text-[#68746d]">
          {creation.allowed
            ? "Create a workspace to invite your team, or open an invitation link someone sent you."
            : "Open an invitation link someone sent you to join their workspace."}
        </p>
      ) : null}
    </div>
  );
}

function OpenWorkspace({
  workspaceId,
  tab,
  onTab,
  onGone,
}: {
  workspaceId: string;
  tab: TabKey;
  onTab(tab: TabKey): void;
  onGone(): void;
}) {
  const api = portalWorkspaceApi;
  const detail = useQuery(workspaceDetailQuery(api, workspaceId));
  const tabsId = useId();
  const tabs = visibleTabs(detail.data);
  const active = tabs.includes(tab) ? tab : (tabs[0] ?? "settings");
  const role = detail.data ? effectiveRole(detail.data) : null;

  return (
    <div className="space-y-4">
      <div className="px-1">
        <h2 className="text-xl font-bold">{detail.data?.name ?? "Workspace"}</h2>
        <div className="text-sm text-[#68746d]">
          {role ? `Your role: ${ROLE_LABELS[role]}` : null}
          <span className="ml-2 font-mono text-xs text-[#a0a3aa]">{workspaceId}</span>
        </div>
      </div>
      <div
        role="tablist"
        aria-label="Workspace sections"
        className="flex flex-wrap items-center gap-1 rounded-[18px] border border-[#e0e4de] bg-[#f7f8f6] p-1"
      >
        {TABS.filter(item => tabs.includes(item.key)).map(item => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`${tabsId}-${item.key}`}
            aria-selected={active === item.key}
            aria-controls={`${tabsId}-panel`}
            onClick={() => onTab(item.key)}
            className={`h-8 whitespace-nowrap rounded-full px-4 text-sm font-semibold ${
              active === item.key ? "bg-white text-[#14151b] shadow-sm" : "text-[#68746d] hover:text-[#14151b]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${active}`}>
        {active === "members" ? <WorkspaceMembersPanel api={api} workspaceId={workspaceId} /> : null}
        {active === "invitations" ? <WorkspaceInvitationsPanel api={api} workspaceId={workspaceId} /> : null}
        {active === "settings" ? (
          <WorkspaceSettingsPanel
            api={api}
            workspaceId={workspaceId}
            onDeleted={onGone}
            onLeft={onGone}
            deleteNotice={STORE_DELETE_NOTICE}
          />
        ) : null}
        {active === "audit" ? <WorkspaceAuditPanel api={api} workspaceId={workspaceId} /> : null}
      </div>
    </div>
  );
}
