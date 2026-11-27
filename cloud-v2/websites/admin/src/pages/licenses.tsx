import { useInfiniteQuery } from "@tanstack/react-query";
import type { AdminLicenseOwner, AdminLicenseView, AdminLicensesResponse, LicenseEndedReason } from "@mentra/workspace-contract";
import { Button, Input, Label, Spinner } from "@mentra/workspace-ui";
import { RefreshCcw } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../lib/api";

/** The shared workspace screens' card (Mentra's tokens, from @mentra/workspace-ui/mentra.css). */
const PANEL = "rounded-card border bg-card";

/** The list's query key. The search text follows it, so each search is its own cached list. */
export const LICENSES_QUERY_KEY = ["admin-licenses"] as const;

/** `GET /api/admin/licenses` for a search text and the cursor of the page after the one already read. */
export function licensesPath(query: string, cursor?: string): string {
  const params = new URLSearchParams();
  const text = query.trim();
  if (text) params.set("query", text);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return search ? `/api/admin/licenses?${search}` : "/api/admin/licenses";
}

const ENDED_REASONS: Record<LicenseEndedReason, string> = {
  workspace_deleted: "workspace deleted",
  lapsed: "subscription ended",
  admin_reset: "admin reset",
};

export interface LicenseState {
  kind: "active" | "upcoming" | "expired" | "ended";
  label: string;
}

/**
 * Where a license stands at `now`. An ended license (its workspace was deleted, or its subscription ended and its term ran out) is ended whatever its term. Otherwise
 * it is active only inside its term, `validFrom <= now < paidThrough` (the rule that puts its features in tokens):
 * expired once paid through, or, for a term with no instant in it, never valid; not started before `validFrom`.
 */
export function licenseState(
  license: Pick<AdminLicenseView, "endedAt" | "endedReason" | "validFrom" | "paidThrough">,
  now: number = Date.now(),
): LicenseState {
  if (license.endedAt) {
    const reason = license.endedReason ? (ENDED_REASONS[license.endedReason] ?? license.endedReason) : null;
    return { kind: "ended", label: reason ? `Ended: ${reason}` : "Ended" };
  }
  const validFrom = Date.parse(license.validFrom);
  if (Date.parse(license.paidThrough) <= Math.max(validFrom, now)) return { kind: "expired", label: "Expired" };
  return validFrom > now ? { kind: "upcoming", label: "Not started" } : { kind: "active", label: "Active" };
}

const STATE_STYLE: Record<LicenseState["kind"], string> = {
  active: "bg-info text-info-foreground",
  upcoming: "bg-surface text-muted-foreground",
  expired: "bg-error text-error-foreground",
  ended: "bg-surface text-muted-foreground",
};

/**
 * Every license in this organization, newest first, with the workspace that holds it, what it is for, how
 * many of its seats are used and what it is paid through. Read-only: seats are assigned by each workspace's
 * Admins and Owners, and nothing on this page changes a license or takes payment. The search matches the
 * workspace's name or id, or the product.
 */
export function LicensesPage() {
  const [query, setQuery] = useState("");
  return <LicenseListing query={query} onSearch={setQuery} />;
}

/** The list for the search `query` (empty for every license). `onSearch` is told what to search for when the form is submitted. */
export function LicenseListing({ query, onSearch }: { query: string; onSearch(query: string): void }) {
  const [draft, setDraft] = useState(query);
  const searchId = useId();
  const licenses = useInfiniteQuery({
    queryKey: [...LICENSES_QUERY_KEY, query],
    queryFn: ({ pageParam }) => api<AdminLicensesResponse>(licensesPath(query, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const rows = licenses.data?.pages.flatMap(page => page.items);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(draft.trim());
  }

  return (
    <section className={PANEL}>
      <div className="flex flex-wrap items-end justify-between gap-4 border-b p-6">
        <div>
          <h2 className="text-xl font-semibold">All products</h2>
          <p className="text-muted-foreground mt-1 text-sm">Newest first, each with the workspace that holds it. This list is read-only.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={search} className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor={searchId}>Search by workspace or product</Label>
              <Input
                id={searchId}
                type="search"
                autoComplete="off"
                maxLength={100}
                placeholder="Workspace name, id or product"
                className="w-72"
                value={draft}
                onChange={event => setDraft(event.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh products"
            disabled={licenses.isFetching}
            onClick={() => void licenses.refetch()}
          >
            <RefreshCcw className={`size-4 ${licenses.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {rows === undefined && licenses.isError ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground m-6 px-4 py-3 text-sm">
          {licenses.error instanceof Error ? licenses.error.message : "Request failed"}
        </p>
      ) : rows === undefined ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 p-6 text-sm">
          <Spinner /> Loading products
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">{query ? `No products match "${query}".` : "No products yet."}</p>
      ) : (
        <LicenseTable licenses={rows} />
      )}

      {licenses.hasNextPage ? (
        <div className="border-t px-6 py-4">
          <Button type="button" variant="secondary" size="sm" disabled={licenses.isFetchingNextPage} onClick={() => void licenses.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * One workspace's licenses, for the Workspaces page: the organization's list searched by the workspace's id,
 * keeping only that workspace's (the search also matches names and products that contain the id's text).
 * Read-only, like the list it comes from: a license is granted from the workspace's row and assigned by the
 * workspace's Admins and Owners. `rowAction` draws what its caller offers on a license, at the end of its row
 * (the Workspaces page's End grant, `workspace-license-end.tsx`); nothing here changes a license or asks Core to.
 */
export function WorkspaceLicenses({ workspaceId, rowAction }: { workspaceId: string; rowAction?: (license: AdminLicenseView) => ReactNode }) {
  const licenses = useInfiniteQuery({
    queryKey: [...LICENSES_QUERY_KEY, workspaceId],
    queryFn: ({ pageParam }) => api<AdminLicensesResponse>(licensesPath(workspaceId, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const rows = licenses.data?.pages.flatMap(page => page.items).filter(license => license.owner.workspaceId === workspaceId);
  return (
    <section className={PANEL}>
      <div className="border-b p-6">
        <h2 className="text-xl font-semibold">Licenses</h2>
        <p className="text-muted-foreground mt-1 text-sm">What this workspace holds, bought or granted. Its admins assign them to people in the workspace portal.</p>
      </div>
      {rows === undefined && licenses.isError ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground m-6 px-4 py-3 text-sm">
          {licenses.error instanceof Error ? licenses.error.message : "Request failed"}
        </p>
      ) : rows === undefined ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 p-6 text-sm">
          <Spinner /> Loading licenses
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">This workspace holds no licenses.</p>
      ) : (
        <LicenseTable licenses={rows} showWorkspace={false} rowAction={rowAction} />
      )}
      {licenses.hasNextPage ? (
        <div className="border-t px-6 py-4">
          <Button type="button" variant="secondary" size="sm" disabled={licenses.isFetchingNextPage} onClick={() => void licenses.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function LicenseTable({
  licenses,
  showWorkspace = true,
  rowAction,
}: {
  licenses: AdminLicenseView[];
  showWorkspace?: boolean;
  /** What the caller offers on a license, drawn in a last column; the table has none without it. */
  rowAction?: (license: AdminLicenseView) => ReactNode;
}) {
  const now = Date.now();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            {showWorkspace ? <th className="px-6 py-3 font-medium">Workspace</th> : null}
            <th className={`py-3 pr-4 font-medium ${showWorkspace ? "" : "pl-6"}`}>Product</th>
            <th className="py-3 pr-4 font-medium">Assigned</th>
            <th className="py-3 pr-4 font-medium">Paid through</th>
            <th className={`py-3 font-medium ${rowAction ? "pr-4" : "pr-6"}`}>Status</th>
            {rowAction ? (
              <th className="py-3 pr-6 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y border-t">
          {licenses.map(license => {
            const state = licenseState(license, now);
            return (
              <tr key={license.licenseId} className="align-top">
                {showWorkspace ? (
                  <td className="px-6 py-3">
                    <Owner owner={license.owner} />
                  </td>
                ) : null}
                <td className={`py-3 pr-4 ${showWorkspace ? "" : "pl-6"}`}>
                  <div>{license.product}</div>
                  <code className="text-muted-foreground text-xs">{license.licenseId}</code>
                </td>
                <td className="py-3 pr-4">
                  {license.seatsUsed} of {license.quantity}
                </td>
                <td className="py-3 pr-4" title={license.paidThrough}>
                  {formatDate(license.paidThrough)}
                </td>
                <td className={`py-3 ${rowAction ? "pr-4" : "pr-6"}`}>
                  <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold ${STATE_STYLE[state.kind]}`}>{state.label}</span>
                  {license.endedAt ? <div className="text-muted-foreground mt-1 text-xs">{formatDate(license.endedAt)}</div> : null}
                </td>
                {rowAction ? <td className="py-2 pr-6 text-right">{rowAction(license)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The workspace by its name, with its id under it; the id alone when Core knows no name for it. */
function Owner({ owner }: { owner: AdminLicenseOwner }) {
  return (
    <div className="min-w-0">
      <div className="font-semibold">{owner.name ?? owner.workspaceId}</div>
      {owner.name !== null ? <code className="text-muted-foreground block truncate text-xs">{owner.workspaceId}</code> : null}
    </div>
  );
}

/** A date as the admin reads it. UTC, so the paid-through day is the same wherever the admin is. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
}
