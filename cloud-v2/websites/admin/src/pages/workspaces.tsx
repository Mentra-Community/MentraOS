import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@mentra/workspace-contract";
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

type TabKey = "members" | "invitations" | "keys" | "settings" | "audit";
const TABS: ReadonlyArray<readonly [TabKey, string]> = [
  ["members", "Members"],
  ["invitations", "Invitations"],
  ["keys", "Keys"],
  ["settings", "Settings"],
  ["audit", "Audit"],
];

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
 * Every workspace in this organization, for Organization Admins: open one to manage it with the shared
 * workspace screens, or recover its ownership. A workspace's own people manage it in the workspace portal.
 */
export function WorkspacesPage({ fleetInstalled = false, portalUrl = WORKSPACE_PORTAL_URL }: { fleetInstalled?: boolean; portalUrl?: string | null } = {}) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("members");
  const tabsTop = useRef<HTMLDivElement>(null);
  const tabsId = useId();

  return (
    <div className="space-y-6">
      <AllWorkspaces
        openWorkspaceId={workspaceId}
        onOpen={id => {
          setWorkspaceId(id);
          setTab("members");
          tabsTop.current?.scrollIntoView?.({ block: "start" });
        }}
      />

      <div ref={tabsTop} className="scroll-mt-24 space-y-4">
        {workspaceId ? (
          <>
            <OpenWorkspaceHeading workspaceId={workspaceId} fleetUrl={fleetInstalled ? fleetOverviewUrl(portalUrl, workspaceId) : null} />
            <div role="tablist" aria-label="Workspace sections" className="bg-surface flex flex-wrap items-center gap-1 rounded-[22px] border p-1">
              {TABS.map(([key, label]) => (
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
          <p className="text-muted-foreground px-1 text-sm">Open a workspace to manage its members, invitations, keys and settings, or to read its audit log.</p>
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

function AllWorkspaces({ openWorkspaceId, onOpen }: { openWorkspaceId: string | null; onOpen(workspaceId: string): void }) {
  const client = useQueryClient();
  const all = useInfiniteQuery({
    queryKey: ORGANIZATION_WORKSPACES_KEY,
    queryFn: ({ pageParam }) =>
      api<{ items: WorkspaceSummary[]; next: string | null }>(
        `/api/admin/organization/workspaces?limit=${ALL_WORKSPACES_PAGE_SIZE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const [recovering, setRecovering] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);

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
      <div className="border-b p-6">
        <h2 className="text-xl font-semibold">All workspaces</h2>
        <p className="text-muted-foreground mt-1 text-sm">Every workspace in this organization, newest first. You act as the owner of any of them.</p>
      </div>
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
                      {openWorkspaceId === workspace.workspaceId ? (
                        <span className="bg-info text-info-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Open</span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">{workspace.workspaceId}</div>
                  </div>
                  {active ? (
                    <div className="flex flex-wrap gap-2">
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
