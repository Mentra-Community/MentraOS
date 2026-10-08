import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@mentra/workspace-contract";
import {
  createWorkspaceApi,
  InvitationAcceptView,
  WorkspaceAuditPanel,
  WorkspaceCredentialsPanel,
  WorkspaceInvitationsPanel,
  WorkspaceMembersPanel,
  WorkspacePicker,
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

/** The dashboard's own workspaces, behind the same origin as the rest of the admin API. */
const workspaceApi = createWorkspaceApi({ basePath: "/api/workspaces" });

/**
 * Nested under the workspace list's key on purpose: every workspace-ui mutation that creates, renames,
 * deletes or leaves a workspace (and accepting an invitation) invalidates `workspaceKeys.list`, so the
 * "All workspaces" list below refetches with it instead of going stale.
 */
export const ORGANIZATION_WORKSPACES_KEY = [...workspaceKeys.list(workspaceApi), "organization"] as const;
const ALL_WORKSPACES_PAGE_SIZE = 50;

/**
 * Core deletes a workspace without asking the Mentra Miniapp Store, so the dashboard says what happens to the
 * miniapps the workspace publishes there.
 */
export const STORE_DELETE_NOTICE =
  "Miniapps this workspace publishes in the Mentra Miniapp Store stay published. The Store holds them until a Store operator assigns them to another workspace.";

type TabKey = "members" | "invitations" | "keys" | "settings" | "audit";
const TABS: ReadonlyArray<readonly [TabKey, string]> = [
  ["members", "Members"],
  ["invitations", "Invitations"],
  ["keys", "Keys"],
  ["settings", "Settings"],
  ["audit", "Audit"],
];

export type MentraUserIdResult = { ok: true; mentraUserId: string } | { ok: false; message: string };

/** The id to make an owner: trimmed, and not blank. Whether such a user exists is the server's answer. */
export function parseMentraUserId(input: string): MentraUserIdResult {
  const mentraUserId = input.trim();
  return mentraUserId ? { ok: true, mentraUserId } : { ok: false, message: "Enter a Mentra user id." };
}

/**
 * Makes `mentraUserId` an owner of the workspace (Organization Admins only, enforced by the server). The
 * server answers an unknown user with a bare `user_not_found`, which would read as "404 Not Found".
 */
export async function recoverWorkspaceOwnership(workspaceId: string, mentraUserId: string): Promise<WorkspaceSummary> {
  try {
    return await api<WorkspaceSummary>(`/api/organization/workspaces/${encodeURIComponent(workspaceId)}/owners`, {
      method: "POST",
      body: { mentraUserId },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "user_not_found") {
      throw new ApiError("No Mentra user has that id.", error.status, error.code);
    }
    throw error;
  }
}

export function WorkspacesPage({
  initialWorkspaceId,
  canAdminister,
  inviteToken,
  onInviteSpent,
}: {
  /** The workspace to open first: the viewer's first one, if they are in any. */
  initialWorkspaceId: string | null;
  /** Whether the viewer is an Organization Admin (`organization.workspaces.administer`). */
  canAdminister: boolean;
  /** The token of an invitation link that was opened, if any. */
  inviteToken: string | null;
  /** Called when the invitation is accepted, so the page can forget the token. */
  onInviteSpent(): void;
}) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(initialWorkspaceId);
  const [tab, setTab] = useState<TabKey>("members");
  const tabsTop = useRef<HTMLDivElement>(null);
  const tabsId = useId();

  function forget() {
    setWorkspaceId(null);
  }

  return (
    <div className="space-y-6">
      {inviteToken ? (
        <InvitationAcceptView
          api={workspaceApi}
          token={inviteToken}
          onAccepted={acceptedId => {
            setWorkspaceId(acceptedId);
            setTab("members");
            onInviteSpent();
          }}
        />
      ) : null}

      <section className={`${PANEL} p-5`}>
        <WorkspacePicker api={workspaceApi} value={workspaceId} onChange={setWorkspaceId} allowCreate />
      </section>

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
                // Organization Admins see user ids: "Recover ownership" below asks for one.
                <WorkspaceMembersPanel api={workspaceApi} workspaceId={workspaceId} showUserIds={canAdminister} />
              ) : null}
              {tab === "invitations" ? <WorkspaceInvitationsPanel api={workspaceApi} workspaceId={workspaceId} /> : null}
              {tab === "keys" ? <WorkspaceCredentialsPanel api={workspaceApi} workspaceId={workspaceId} /> : null}
              {tab === "settings" ? (
                <WorkspaceSettingsPanel
                  api={workspaceApi}
                  workspaceId={workspaceId}
                  onDeleted={forget}
                  onLeft={forget}
                  deleteNotice={STORE_DELETE_NOTICE}
                />
              ) : null}
              {tab === "audit" ? <WorkspaceAuditPanel api={workspaceApi} workspaceId={workspaceId} /> : null}
            </div>
          </>
        ) : (
          <p className="px-1 text-sm text-[#68746d]">Pick a workspace to manage its members, invitations, keys and settings, or to read its audit log.</p>
        )}
      </div>

      {canAdminister ? (
        <AllWorkspaces
          onOpen={id => {
            setWorkspaceId(id);
            setTab("members");
            tabsTop.current?.scrollIntoView?.({ block: "start" });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The name of the workspace the panels below show. An Organization Admin can open a workspace they are not
 * in, which the picker cannot name, so the page names it here. Shares the panels' cached detail query.
 */
function OpenWorkspaceHeading({ workspaceId }: { workspaceId: string }) {
  const detail = useQuery(workspaceDetailQuery(workspaceApi, workspaceId));
  return (
    <div className="px-1">
      <h2 className="text-xl font-bold">{detail.data?.name ?? "Workspace"}</h2>
      <div className="truncate font-mono text-xs text-[#a0a3aa]">{workspaceId}</div>
    </div>
  );
}

/**
 * Every workspace in the organization, newest first (Organization Admins only). An admin acts as an owner
 * of any of them, so "Open" shows it in the panels above; "Recover ownership" is for a workspace whose
 * owners are all gone.
 */
function AllWorkspaces({ onOpen }: { onOpen(workspaceId: string): void }) {
  const client = useQueryClient();
  const all = useInfiniteQuery({
    queryKey: ORGANIZATION_WORKSPACES_KEY,
    queryFn: ({ pageParam }) =>
      api<{ items: WorkspaceSummary[]; next: string | null }>(
        `/api/organization/workspaces?limit=${ALL_WORKSPACES_PAGE_SIZE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const [recovering, setRecovering] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);

  const recover = useMutation({
    mutationFn: (request: { workspace: WorkspaceSummary; mentraUserId: string }) =>
      recoverWorkspaceOwnership(request.workspace.workspaceId, request.mentraUserId),
    gcTime: 0,
    onSuccess: async (_summary, request) => {
      setRecovering(null);
      setRecovered(`${request.mentraUserId} is now an owner of ${request.workspace.name}.`);
      // The members and revision of that workspace changed under any panel showing it, and the viewer's own
      // workspace list changes if they made themselves its owner.
      await Promise.all([
        client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspaceApi, request.workspace.workspaceId) }),
        client.invalidateQueries({ queryKey: workspaceKeys.list(workspaceApi) }),
      ]);
    },
  });

  const rows = all.data?.pages.flatMap(page => page.items);

  return (
    <section className={PANEL}>
      <div className="border-b border-[#eceeeb] p-5">
        <h2 className="text-xl font-bold">All workspaces</h2>
        <p className="mt-1 text-sm text-[#68746d]">Every workspace in this organization, including ones you are not a member of.</p>
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
                    onSubmit={mentraUserId => recover.mutate({ workspace, mentraUserId })}
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

/** Asks which person should own the workspace. The id is checked for blankness here; the server checks it exists. */
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
  onSubmit(mentraUserId: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const inputId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseMentraUserId(value);
    if (!parsed.ok) {
      setInvalid(parsed.message);
      return;
    }
    setInvalid(null);
    onSubmit(parsed.mentraUserId);
  }

  const shown = invalid ?? error;
  return (
    <form onSubmit={submit} className="space-y-3 rounded-[14px] bg-[#f7f8f6] p-4">
      <p className="text-sm text-[#4f5d54]">
        Make this person an owner of <strong>{workspaceName}</strong>. They are added to the workspace if they are not in it.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>Mentra user id</Label>
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
