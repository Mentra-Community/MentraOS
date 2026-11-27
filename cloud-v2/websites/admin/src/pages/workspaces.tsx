import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LicenseGrant, OrganizationWorkspaceListItem, WorkspaceSummary } from "@mentra/workspace-contract";
import {
  Button,
  createWorkspaceApi,
  Input,
  Label,
  Spinner,
  WorkspaceAuditPanel,
  WorkspaceCredentialsPanel,
  WorkspaceInvitationsPanel,
  WorkspaceMembersPanel,
  WorkspaceSettingsPanel,
  workspaceDetailQuery,
  workspaceKeys,
} from "@mentra/workspace-ui";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { fleetOverviewUrl, WORKSPACE_PORTAL_URL } from "../lib/config";
import { LICENSES_QUERY_KEY } from "./licenses";
import { CreateWorkspaceDialog, createdWorkspaceMessage, type CreatedWorkspace } from "./workspace-create";
import { WorkspaceLicensesWithEnding } from "./workspace-license-end";
import { grantedMessage, LicenseGrantDialog } from "./workspace-license-grant";
import { WorkspaceLicenseReset } from "./workspace-license-reset";

/** The shared workspace screens' card (Mentra's tokens, from @mentra/workspace-ui/mentra.css). */
const PANEL = "rounded-card border bg-card";

/**
 * Core's workspace API, reached with the admin portal's session. An Organization Admin acts as the owner
 * of any workspace, so the shared panels work on every workspace here.
 */
export const adminWorkspaceApi = createWorkspaceApi({ basePath: "/api/admin/workspaces" });

/**
 * Nested under the workspace list's key on purpose: every workspace-ui mutation that renames, deletes or
 * leaves a workspace invalidates `workspaceKeys.list`, so the list below refetches with it.
 */
export const ORGANIZATION_WORKSPACES_KEY = [...workspaceKeys.list(adminWorkspaceApi), "organization"] as const;
const ALL_WORKSPACES_PAGE_SIZE = 50;

/**
 * The Mentra Miniapp Store holds a workspace from deletion while it owns any miniapp, a draft included
 * (the settings screen then says how many, instead of offering the delete). While nothing holds the
 * workspace, the page still states the rule.
 */
export const STORE_DELETE_NOTICE =
  "A workspace that owns miniapps in the Mentra Miniapp Store can't be deleted. Delete its miniapps first.";

type TabKey = "members" | "invitations" | "licenses" | "keys" | "settings" | "audit";
const TABS: ReadonlyArray<readonly [TabKey, string]> = [
  ["members", "Members"],
  ["invitations", "Invitations"],
  ["licenses", "Licenses"],
  ["keys", "Keys"],
  ["settings", "Settings"],
  ["audit", "Audit"],
];

/**
 * Whether the list should say a workspace has no Owner: an active one Core counts none for. One made here
 * waits for the Owner invited to it, and an invitation that expires says nothing, so this is what shows it.
 * A Core that does not send the count says nothing either way.
 */
export function hasNoOwner(workspace: Pick<OrganizationWorkspaceListItem, "status" | "owners">): boolean {
  return workspace.status === "active" && workspace.owners === 0;
}

/** Who to make an owner: an account email, or a Mentra user id. */
export type OwnerTarget = { email: string } | { mentraUserId: string };
export type OwnerTargetResult = { ok: true; target: OwnerTarget } | { ok: false; message: string };

/** The person the form names: an email when it has an `@`, otherwise a Mentra user id. Blank is refused. */
export function parseOwnerTarget(input: string): OwnerTargetResult {
  const value = input.trim();
  if (!value) return { ok: false, message: "Enter an email address or a Mentra user id." };
  return { ok: true, target: value.includes("@") ? { email: value } : { mentraUserId: value } };
}

/**
 * Makes the person an owner of the workspace (Organization Admins only, enforced by Core). Core answers a
 * person it does not know with a bare `user_not_found`, which would read as "404 Not Found".
 */
export async function recoverWorkspaceOwnership(workspaceId: string, target: OwnerTarget): Promise<WorkspaceSummary> {
  try {
    return await api<WorkspaceSummary>(`/api/admin/organization/workspaces/${encodeURIComponent(workspaceId)}/owners`, {
      method: "POST",
      body: target,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "user_not_found") {
      throw new ApiError("No Mentra account matches that email or user id.", error.status, error.code);
    }
    throw error;
  }
}

/**
 * Every workspace in this organization, for Organization Admins: make one for a customer and invite its
 * owner, open one to manage it with the shared workspace screens, recover its ownership, or grant it
 * licenses. A workspace's own people manage it in the workspace portal.
 *
 * `canGrantLicenses` offers the grant (the caller holds `organization.licenses.grant`), and `licensesReadable`
 * the open workspace's Licenses tab (`organization.licenses.read`, with billing or a license on this Core). With
 * both, that tab also offers End grant on each active license (`workspace-license-end.tsx`).
 */
export function WorkspacesPage({
  fleetInstalled = false,
  portalUrl = WORKSPACE_PORTAL_URL,
  resetEnabled = false,
  canGrantLicenses = false,
  licensesReadable = false,
}: { fleetInstalled?: boolean; portalUrl?: string | null; resetEnabled?: boolean; canGrantLicenses?: boolean; licensesReadable?: boolean } = {}) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("members");
  const tabsTop = useRef<HTMLDivElement>(null);
  const tabsId = useId();
  const tabs = TABS.filter(([key]) => key !== "licenses" || licensesReadable);

  function open(id: string, to: TabKey = "members") {
    setWorkspaceId(id);
    setTab(to);
    tabsTop.current?.scrollIntoView?.({ block: "start" });
  }

  return (
    <div className="space-y-6">
      <AllWorkspaces
        resetEnabled={resetEnabled}
        canGrantLicenses={canGrantLicenses}
        portalUrl={portalUrl}
        openWorkspaceId={workspaceId}
        onOpen={id => open(id)}
        onCreated={created => open(created.workspaceId, "invitations")}
      />

      <div ref={tabsTop} className="scroll-mt-24 space-y-4">
        {workspaceId ? (
          <>
            <OpenWorkspaceHeading workspaceId={workspaceId} fleetUrl={fleetInstalled ? fleetOverviewUrl(portalUrl, workspaceId) : null} />
            <div role="tablist" aria-label="Workspace sections" className="bg-surface flex flex-wrap items-center gap-1 rounded-[22px] border p-1">
              {tabs.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  aria-controls={`${tabsId}-panel`}
                  id={`${tabsId}-${key}`}
                  onClick={() => setTab(key)}
                  className={`h-9 cursor-pointer whitespace-nowrap rounded-full px-4 text-sm font-semibold ${
                    tab === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} key={workspaceId}>
              {tab === "members" ? (
                // Organization Admins see user ids: ownership recovery can name a person by one.
                <WorkspaceMembersPanel api={adminWorkspaceApi} workspaceId={workspaceId} showUserIds />
              ) : null}
              {tab === "invitations" ? <WorkspaceInvitationsPanel api={adminWorkspaceApi} workspaceId={workspaceId} /> : null}
              {tab === "licenses" ? <OpenWorkspaceLicenses workspaceId={workspaceId} canGrantLicenses={canGrantLicenses} /> : null}
              {tab === "keys" ? <WorkspaceCredentialsPanel api={adminWorkspaceApi} workspaceId={workspaceId} /> : null}
              {tab === "settings" ? (
                <WorkspaceSettingsPanel
                  api={adminWorkspaceApi}
                  workspaceId={workspaceId}
                  onDeleted={() => setWorkspaceId(null)}
                  onLeft={() => setWorkspaceId(null)}
                  deleteNotice={STORE_DELETE_NOTICE}
                />
              ) : null}
              {tab === "audit" ? <WorkspaceAuditPanel api={adminWorkspaceApi} workspaceId={workspaceId} /> : null}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground px-1 text-sm">Open a workspace to manage its members, invitations, keys and settings, or to read its licenses and audit log.</p>
        )}
      </div>
    </div>
  );
}

/** The name of the open workspace, which the admin may not belong to. Shares the panels' cached detail query. */
function OpenWorkspaceHeading({ workspaceId, fleetUrl }: { workspaceId: string; fleetUrl: string | null }) {
  const detail = useQuery(workspaceDetailQuery(adminWorkspaceApi, workspaceId));
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-1">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold">{detail.data?.name ?? "Workspace"}</h2>
        <div className="text-muted-foreground truncate font-mono text-xs">{workspaceId}</div>
      </div>
      {fleetUrl ? (
        // The workspace portal opens Fleet Management for any workspace to an Organization Admin, member or not.
        <a href={fleetUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold underline underline-offset-4">
          Open Fleet Management
        </a>
      ) : null}
    </div>
  );
}

/**
 * The open workspace's licenses, with End grant for a caller who may grant. The dialog names the workspace, from
 * the panels' cached detail query; until that has answered, by its id.
 */
function OpenWorkspaceLicenses({ workspaceId, canGrantLicenses }: { workspaceId: string; canGrantLicenses: boolean }) {
  const detail = useQuery(workspaceDetailQuery(adminWorkspaceApi, workspaceId));
  return <WorkspaceLicensesWithEnding workspace={{ workspaceId, name: detail.data?.name ?? workspaceId }} canEndGrants={canGrantLicenses} />;
}

function AllWorkspaces({
  openWorkspaceId,
  onOpen,
  onCreated,
  portalUrl,
  resetEnabled,
  canGrantLicenses,
}: {
  openWorkspaceId: string | null;
  onOpen(workspaceId: string): void;
  /** A workspace was made here: the page opens it on its invitations. */
  onCreated(created: CreatedWorkspace): void;
  portalUrl: string | null;
  resetEnabled: boolean;
  canGrantLicenses: boolean;
}) {
  const client = useQueryClient();
  const all = useInfiniteQuery({
    queryKey: ORGANIZATION_WORKSPACES_KEY,
    queryFn: ({ pageParam }) =>
      api<{ items: OrganizationWorkspaceListItem[]; next: string | null }>(
        `/api/admin/organization/workspaces?limit=${ALL_WORKSPACES_PAGE_SIZE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const [recovering, setRecovering] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);
  const [resetWorkspaceId, setResetWorkspaceId] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);
  const [granting, setGranting] = useState<{ workspaceId: string; name: string } | null>(null);
  const [granted, setGranted] = useState<string | null>(null);

  const recover = useMutation({
    mutationFn: (request: { workspace: WorkspaceSummary; target: OwnerTarget; label: string }) =>
      recoverWorkspaceOwnership(request.workspace.workspaceId, request.target),
    gcTime: 0,
    onSuccess: async (_summary, request) => {
      setRecovering(null);
      setRecovered(`${request.label} is now an owner of ${request.workspace.name}.`);
      // The members and revision of that workspace changed under any panel showing it.
      await Promise.all([
        client.invalidateQueries({ queryKey: workspaceKeys.workspace(adminWorkspaceApi, request.workspace.workspaceId) }),
        client.invalidateQueries({ queryKey: workspaceKeys.list(adminWorkspaceApi) }),
      ]);
    },
  });

  const rows = all.data?.pages.flatMap(page => page.items);

  return (
    <section className={PANEL}>
      {resetWorkspaceId ? <WorkspaceLicenseReset key={resetWorkspaceId} workspaceId={resetWorkspaceId} onClose={() => setResetWorkspaceId(null)} onReset={result => {
        setResetWorkspaceId(null);
        setResetMessage(`Reset complete: ${result.canceledSubscriptions} subscriptions canceled, ${result.endedProducts} products ended, ${result.releasedAssignments} assignments removed, and ${result.expiredCheckouts} checkouts expired.`);
        void client.invalidateQueries({queryKey: ["admin-licenses"]});
        void client.invalidateQueries({queryKey: workspaceKeys.list(adminWorkspaceApi)});
      }} /> : null}
      {resetMessage ? <p role="status" className="m-6 text-sm">{resetMessage}</p> : null}
      {creating ? (
        <CreateWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreated={workspace => {
            setCreating(false);
            setCreated(workspace);
            void client.invalidateQueries({ queryKey: workspaceKeys.list(adminWorkspaceApi) });
            onCreated(workspace);
          }}
        />
      ) : null}
      {granting ? (
        <LicenseGrantDialog
          key={granting.workspaceId}
          workspace={granting}
          onClose={() => setGranting(null)}
          onGranted={(grant: LicenseGrant) => {
            setGranted(grantedMessage(granting.name, grant));
            setGranting(null);
            void client.invalidateQueries({ queryKey: LICENSES_QUERY_KEY });
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b p-6">
        <div>
          <h2 className="text-xl font-semibold">All workspaces</h2>
          <p className="text-muted-foreground mt-1 text-sm">Every workspace in this organization, newest first. You act as the owner of any of them.</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setCreated(null);
            setCreating(true);
          }}
        >
          New workspace
        </Button>
      </div>
      {created ? (
        <p role="status" className={`rounded-notice m-6 px-4 py-3 text-sm ${created.invitationProblem === null ? "bg-info text-info-foreground" : "bg-error text-error-foreground"}`}>
          {createdWorkspaceMessage(created)}
        </p>
      ) : null}
      {granted ? (
        <p role="status" className="rounded-notice bg-info text-info-foreground m-6 px-4 py-3 text-sm">
          {granted}
        </p>
      ) : null}
      {rows === undefined && all.isError ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground m-6 px-4 py-3 text-sm">
          {all.error instanceof Error ? all.error.message : "Request failed"}
        </p>
      ) : rows === undefined ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 p-6 text-sm">
          <Spinner /> Loading workspaces
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">There are no workspaces yet.</p>
      ) : (
        <ul className="divide-y">
          {rows.map(workspace => {
            const active = workspace.status === "active";
            return (
              <li key={workspace.workspaceId} className="space-y-3 px-6 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-semibold">
                      {workspace.name}
                      {active ? null : (
                        <span className="bg-surface text-muted-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Deleted</span>
                      )}
                      {hasNoOwner(workspace) ? (
                        <span
                          className="bg-error text-error-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold"
                          title="Nobody owns this workspace. Invite an owner from its Invitations, or use Recover ownership for someone who has an account."
                        >
                          No owner
                        </span>
                      ) : null}
                      {openWorkspaceId === workspace.workspaceId ? (
                        <span className="bg-info text-info-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Open</span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">{workspace.workspaceId}</div>
                  </div>
                  {active ? (
                    <div className="flex flex-wrap gap-2">
                      {portalUrl ? (
                        <Button asChild size="sm">
                          <a href={`${portalUrl}/?workspace=${encodeURIComponent(workspace.workspaceId)}`} target="_blank" rel="noreferrer" aria-label={`Manage workspace ${workspace.name}`}>
                            Manage workspace ↗
                          </a>
                        </Button>
                      ) : null}
                      {canGrantLicenses ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Grant licenses to ${workspace.name}`}
                          onClick={() => {
                            setGranted(null);
                            setGranting({ workspaceId: workspace.workspaceId, name: workspace.name });
                          }}
                        >
                          Grant licenses
                        </Button>
                      ) : null}
                      {resetEnabled ? <Button variant="destructive-secondary" size="sm" aria-label={`Reset licenses and billing for ${workspace.name}`} onClick={() => {setResetMessage(null); setResetWorkspaceId(workspace.workspaceId);}}>Reset licenses & billing</Button> : null}
                      <Button variant="secondary" size="sm" aria-label={`Open ${workspace.name}`} onClick={() => onOpen(workspace.workspaceId)}>
                        Open
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Recover ownership of ${workspace.name}`}
                        aria-expanded={recovering === workspace.workspaceId}
                        onClick={() => {
                          recover.reset();
                          setRecovered(null);
                          setRecovering(current => (current === workspace.workspaceId ? null : workspace.workspaceId));
                        }}
                      >
                        Recover ownership
                      </Button>
                    </div>
                  ) : null}
                </div>
                {active && recovering === workspace.workspaceId ? (
                  <RecoverOwnershipForm
                    workspaceName={workspace.name}
                    pending={recover.isPending}
                    error={recover.error ? recover.error.message : null}
                    onSubmit={(target, label) => recover.mutate({ workspace, target, label })}
                    onCancel={() => {
                      recover.reset();
                      setRecovering(null);
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {recovered ? (
        <p role="status" className="rounded-notice bg-info text-info-foreground m-6 px-4 py-3 text-sm">
          {recovered}
        </p>
      ) : null}
      {all.hasNextPage ? (
        <div className="border-t px-6 py-4">
          <Button variant="secondary" size="sm" disabled={all.isFetchingNextPage} onClick={() => void all.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Asks which person should own the workspace. Blankness is checked here; Core checks the person exists. */
export function RecoverOwnershipForm({
  workspaceName,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  workspaceName: string;
  pending: boolean;
  /** Why the last attempt failed, in words. */
  error: string | null;
  onSubmit(target: OwnerTarget, label: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const inputId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseOwnerTarget(value);
    if (!parsed.ok) {
      setInvalid(parsed.message);
      return;
    }
    setInvalid(null);
    onSubmit(parsed.target, value.trim());
  }

  const shown = invalid ?? error;
  return (
    <form onSubmit={submit} className="rounded-notice space-y-3 border p-4">
      <p className="text-muted-foreground text-sm">
        Make this person an owner of <strong>{workspaceName}</strong>. They are added to the workspace if they are not in it.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor={inputId}>Account email or Mentra user id</Label>
          <Input
            id={inputId}
            autoFocus
            autoComplete="off"
            className="w-72"
            aria-invalid={invalid ? true : undefined}
            value={value}
            onChange={event => setValue(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending}>
          Make owner
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {shown ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
          {shown}
        </p>
      ) : null}
    </form>
  );
}
