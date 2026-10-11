import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@mentra/workspace-contract";
import {
  createWorkspaceApi,
  WorkspaceAuditPanel,
  WorkspaceCredentialsPanel,
  WorkspaceInvitationsPanel,
  WorkspaceMembersPanel,
  WorkspaceSettingsPanel,
  workspaceDetailQuery,
  workspaceKeys,
} from "@mentra/workspace-ui";
import { Loader2 } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "../lib/api";

const PANEL = "rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]";

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
 * Core deletes a workspace without asking the Mentra Miniapp Store, so the page says what happens to the
 * miniapps the workspace publishes there.
 */
export const STORE_DELETE_NOTICE =
  "Miniapps this workspace publishes in the Mentra Miniapp Store stay published, and nobody can manage them until a Store operator assigns them to another workspace.";

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
export function WorkspacesPage() {
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
            <OpenWorkspaceHeading workspaceId={workspaceId} />
            <div role="tablist" aria-label="Workspace sections" className="flex flex-wrap items-center gap-1 rounded-[18px] border border-[#e0e4de] bg-[#f7f8f6] p-1">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  aria-controls={`${tabsId}-panel`}
                  id={`${tabsId}-${key}`}
                  onClick={() => setTab(key)}
                  className={`h-8 whitespace-nowrap rounded-full px-4 text-sm font-semibold ${
                    tab === key ? "bg-white text-[#14151b] shadow-sm" : "text-[#68746d] hover:text-[#14151b]"
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
          <p className="px-1 text-sm text-[#68746d]">Open a workspace to manage its members, invitations, keys and settings, or to read its audit log.</p>
        )}
      </div>
    </div>
  );
}

/** The name of the open workspace, which the admin may not belong to. Shares the panels' cached detail query. */
function OpenWorkspaceHeading({ workspaceId }: { workspaceId: string }) {
  const detail = useQuery(workspaceDetailQuery(adminWorkspaceApi, workspaceId));
  return (
    <div className="px-1">
      <h2 className="text-xl font-bold">{detail.data?.name ?? "Workspace"}</h2>
      <div className="truncate font-mono text-xs text-[#a0a3aa]">{workspaceId}</div>
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
      <div className="border-b border-[#eceeeb] p-5">
        <h2 className="text-xl font-bold">All workspaces</h2>
        <p className="mt-1 text-sm text-[#68746d]">Every workspace in this organization, newest first. You act as the owner of any of them.</p>
      </div>
      {rows === undefined && all.isError ? (
        <p role="alert" className="m-5 rounded-[14px] bg-[#fff3f1] p-3 text-sm text-[#a64235]">
          {all.error instanceof Error ? all.error.message : "Request failed"}
        </p>
      ) : rows === undefined ? (
        <div role="status" className="flex items-center gap-3 p-5 text-[#68746d]">
          <Loader2 className="size-5 animate-spin" /> Loading workspaces
        </div>
      ) : rows.length === 0 ? (
        <p className="p-5 text-sm text-[#68746d]">There are no workspaces yet.</p>
      ) : (
        <ul className="divide-y divide-[#eceeeb]">
          {rows.map(workspace => {
            const active = workspace.status === "active";
            return (
              <li key={workspace.workspaceId} className="space-y-3 p-4 px-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-semibold">
                      {workspace.name}
                      {active ? null : (
                        <span className="rounded-full bg-[#f0f2ef] px-2.5 py-0.5 text-xs font-semibold text-[#4f5d54]">Deleted</span>
                      )}
                      {openWorkspaceId === workspace.workspaceId ? (
                        <span className="rounded-full bg-[#e9f8f1] px-2.5 py-0.5 text-xs font-semibold text-[#087d50]">Open</span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-xs text-[#a0a3aa]">{workspace.workspaceId}</div>
                  </div>
                  {active ? (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" aria-label={`Open ${workspace.name}`} onClick={() => onOpen(workspace.workspaceId)}>
                        Open
                      </Button>
                      <Button
                        variant="outline"
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
        <p role="status" className="m-5 rounded-[14px] bg-[#e9f8f1] p-3 text-sm text-[#087d50]">
          {recovered}
        </p>
      ) : null}
      {all.hasNextPage ? (
        <div className="border-t border-[#eceeeb] p-4">
          <Button variant="outline" size="sm" disabled={all.isFetchingNextPage} onClick={() => void all.fetchNextPage()}>
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
    <form onSubmit={submit} className="space-y-3 rounded-[14px] bg-[#f7f8f6] p-4">
      <p className="text-sm text-[#4f5d54]">
        Make this person an owner of <strong>{workspaceName}</strong>. They are added to the workspace if they are not in it.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
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
        <Button type="submit" size="sm" disabled={pending}>
          Make owner
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {shown ? (
        <p role="alert" className="text-sm text-[#a64235]">
          {shown}
        </p>
      ) : null}
    </form>
  );
}
