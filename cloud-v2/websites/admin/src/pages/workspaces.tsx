import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationWorkspaceListItem } from "@mentra/workspace-contract";
import { Button, Checkbox, createWorkspaceApi, Input, Label, Spinner, workspaceKeys } from "@mentra/workspace-ui";
import { useId, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { CreateWorkspaceDialog, createdWorkspaceMessage, type CreatedWorkspace } from "./workspace-create";

/** The shared workspace screens' card (Mentra's tokens, from @mentra/workspace-ui/mentra.css). */
const PANEL = "rounded-card border bg-card";

/** Core's workspace API, reached with the admin portal's session: the scope the list's cache key lives under. */
export const adminWorkspaceApi = createWorkspaceApi({ basePath: "/api/admin/workspaces" });

/**
 * Nested under the workspace list's key on purpose: every workspace-ui mutation that renames, deletes or
 * leaves a workspace invalidates `workspaceKeys.list`, so the list below refetches with it.
 */
export const ORGANIZATION_WORKSPACES_KEY = [...workspaceKeys.list(adminWorkspaceApi), "organization"] as const;
const ALL_WORKSPACES_PAGE_SIZE = 50;

/** What the list is searched for: text, and whether member and invitation emails count. */
export interface WorkspaceSearch {
  query: string;
  emails: boolean;
}

/**
 * `GET /api/admin/organization/workspaces` for a page of the list, searched or not. `before` is the id of the last
 * workspace of the page before. With no text the whole list comes back, whatever `emails` says.
 */
export function workspacesPath(search: WorkspaceSearch, before?: string): string {
  const params = new URLSearchParams({ limit: String(ALL_WORKSPACES_PAGE_SIZE) });
  const query = search.query.trim();
  if (query) {
    params.set("query", query);
    if (search.emails) params.set("emails", "true");
  }
  if (before) params.set("before", before);
  return `/api/admin/organization/workspaces?${params}`;
}

/** The list's query key: the unsearched list under `ORGANIZATION_WORKSPACES_KEY` itself, a search beneath it. */
export function workspacesKey(search: WorkspaceSearch) {
  const query = search.query.trim();
  return query ? ([...ORGANIZATION_WORKSPACES_KEY, query, search.emails] as const) : ORGANIZATION_WORKSPACES_KEY;
}

/**
 * Whether the list should say a workspace has no Owner: an active one Core counts none for. One made here
 * waits for the Owner invited to it, and an invitation that expires says nothing, so this is what shows it.
 * A Core that does not send the count says nothing either way.
 */
export function hasNoOwner(workspace: Pick<OrganizationWorkspaceListItem, "status" | "owners">): boolean {
  return workspace.status === "active" && workspace.owners === 0;
}

/** Where Manage workspace opens a workspace: Mentra Portal, on it, where an Organization Admin acts as its Owner. */
export function manageWorkspaceUrl(portalUrl: string, workspaceId: string): string {
  return `${portalUrl}/?workspace=${encodeURIComponent(workspaceId)}`;
}

/**
 * Every workspace in this organization, for Organization Admins: find one (by name or id, or by a member's or an
 * invited person's email), make one for a customer and invite its Owner, and open any in Mentra Portal with
 * **Manage workspace**. Everything done to one workspace (its members, licenses and grants, Owners, keys, audit
 * log) is there, on its pages and its Admin tools page; this page is about the organization.
 *
 * `portalUrl` is Mentra Portal's address as Core gives it (`GET /api/admin/me`, `portal.url`); without one there is
 * nowhere to manage a workspace, and the list says so.
 */
export function WorkspacesPage({ portalUrl }: { portalUrl: string | null }) {
  const client = useQueryClient();
  const [search, setSearch] = useState<WorkspaceSearch>({ query: "", emails: false });
  const all = useInfiniteQuery({
    queryKey: workspacesKey(search),
    queryFn: ({ pageParam }) =>
      api<{ items: OrganizationWorkspaceListItem[]; next: string | null }>(workspacesPath(search, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);
  const rows = all.data?.pages.flatMap(page => page.items);

  return (
    <section className={PANEL}>
      {creating ? (
        <CreateWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreated={workspace => {
            setCreating(false);
            setCreated(workspace);
            void client.invalidateQueries({ queryKey: workspaceKeys.list(adminWorkspaceApi) });
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b p-6">
        <div>
          <h2 className="text-xl font-semibold">All workspaces</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Every workspace in this organization, newest first. Manage one in Mentra Portal, where you act as its owner and have its Admin tools.
          </p>
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
        <div
          role="status"
          className={`rounded-notice m-6 flex flex-wrap items-center gap-3 px-4 py-3 text-sm ${created.invitationProblem === null ? "bg-info text-info-foreground" : "bg-error text-error-foreground"}`}
        >
          <span className="min-w-0 flex-1">{createdWorkspaceMessage(created)}</span>
          {portalUrl ? (
            <a href={manageWorkspaceUrl(portalUrl, created.workspaceId)} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-4">
              Manage workspace ↗
            </a>
          ) : null}
        </div>
      ) : null}
      {portalUrl ? null : (
        <p role="note" className="rounded-notice bg-error text-error-foreground m-6 px-4 py-3 text-sm">
          This Core has no Mentra Portal address (CLOUD_CORE_ENTERPRISE_PORTAL_URL), so workspaces can't be opened from here.
        </p>
      )}
      <WorkspaceSearchForm search={search} onSearch={setSearch} />
      {rows === undefined && all.isError ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground m-6 px-4 py-3 text-sm">
          {all.error instanceof Error ? all.error.message : "Request failed"}
        </p>
      ) : rows === undefined ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 p-6 text-sm">
          <Spinner /> Loading workspaces
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">
          {search.query.trim() ? `No workspace matches "${search.query.trim()}"${search.emails ? " by name or email" : " by name"}.` : "There are no workspaces yet."}
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map(workspace => {
            const active = workspace.status === "active";
            return (
              <li key={workspace.workspaceId} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-semibold">
                    {workspace.name}
                    {active ? null : (
                      <span className="bg-surface text-muted-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Deleted</span>
                    )}
                    {hasNoOwner(workspace) ? (
                      <span
                        className="bg-error text-error-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold"
                        title="Nobody owns this workspace. Invite an owner from its Members page, or use Make owner on its Admin tools page for someone who has an account."
                      >
                        No owner
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground truncate font-mono text-xs">{workspace.workspaceId}</div>
                </div>
                {active && portalUrl ? (
                  <Button asChild size="sm">
                    <a href={manageWorkspaceUrl(portalUrl, workspace.workspaceId)} target="_blank" rel="noreferrer" aria-label={`Manage workspace ${workspace.name}`}>
                      Manage workspace ↗
                    </a>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
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

/**
 * Searches the list: by name (or id), and with the box ticked also by the email of a member or of a pending
 * invitation, which finds a customer's workspace by the owner invited to it. Searching happens on submit.
 */
export function WorkspaceSearchForm({ search, onSearch }: { search: WorkspaceSearch; onSearch(search: WorkspaceSearch): void }) {
  const [query, setQuery] = useState(search.query);
  const [emails, setEmails] = useState(search.emails);
  const searchId = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch({ query: query.trim(), emails });
  }
  return (
    <form onSubmit={submit} role="search" aria-label="Workspace search" className="flex flex-wrap items-end gap-3 border-b px-6 py-4">
      <div className="grid gap-2">
        <Label htmlFor={searchId}>Search workspaces</Label>
        <Input
          id={searchId}
          type="search"
          autoComplete="off"
          maxLength={100}
          placeholder={emails ? "Name, id or email" : "Name or id"}
          className="w-72"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>
      <Checkbox label="Also search member and invitation emails" checked={emails} onChange={event => setEmails(event.target.checked)} className="h-11" />
      <Button type="submit" variant="secondary">
        Search
      </Button>
      {search.query ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setQuery("");
            onSearch({ query: "", emails });
          }}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
}
