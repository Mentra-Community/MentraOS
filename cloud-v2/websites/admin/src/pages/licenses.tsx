import { useInfiniteQuery } from "@tanstack/react-query";
import type { AdminLicenseOwner, AdminLicenseView, AdminLicensesResponse, LicenseEndedReason } from "@mentra/workspace-contract";
import { Button, Input, Label, Spinner } from "@mentra/workspace-ui";
import { RefreshCcw } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
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
  account_deleted: "account deleted",
};

export interface LicenseState {
  kind: "active" | "upcoming" | "expired" | "ended";
  label: string;
}

/**
 * Where a license stands at `now`. An ended license (its owner was deleted) is ended whatever its term. Otherwise
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
 * Every license in this organization, workspace and personal, newest first, with who holds it, what it is
 * for, how many of its seats are used and what it is paid through. Read-only: seats are assigned by each
 * workspace's Admins and Owners, and nothing on this page changes a license or takes payment. The search
 * matches the owner's name, email or id, or the product.
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
          <h2 className="text-xl font-semibold">All licenses</h2>
          <p className="text-muted-foreground mt-1 text-sm">Newest first, held by workspaces and by people. This list is read-only.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={search} className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor={searchId}>Search by owner or product</Label>
              <Input
                id={searchId}
                type="search"
                autoComplete="off"
                maxLength={100}
                placeholder="Name, email, id or product"
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
            aria-label="Refresh licenses"
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
          <Spinner /> Loading licenses
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">{query ? `No licenses match "${query}".` : "No licenses yet."}</p>
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

function LicenseTable({ licenses }: { licenses: AdminLicenseView[] }) {
  const now = Date.now();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            <th className="px-6 py-3 font-medium">Owner</th>
            <th className="py-3 pr-4 font-medium">Product</th>
            <th className="py-3 pr-4 font-medium">Seats used</th>
            <th className="py-3 pr-4 font-medium">Paid through</th>
            <th className="py-3 pr-6 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y border-t">
          {licenses.map(license => {
            const state = licenseState(license, now);
            return (
              <tr key={license.licenseId} className="align-top">
                <td className="px-6 py-3">
                  <Owner owner={license.owner} />
                </td>
                <td className="py-3 pr-4">
                  <div>{license.product}</div>
                  <code className="text-muted-foreground text-xs">{license.licenseId}</code>
                </td>
                <td className="py-3 pr-4">
                  {license.seatsUsed} of {license.quantity}
                </td>
                <td className="py-3 pr-4" title={license.paidThrough}>
                  {formatDate(license.paidThrough)}
                </td>
                <td className="py-3 pr-6">
                  <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold ${STATE_STYLE[state.kind]}`}>{state.label}</span>
                  {license.endedAt ? <div className="text-muted-foreground mt-1 text-xs">{formatDate(license.endedAt)}</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The owner by name or email, with its kind and id; the id stands in when Core knows no name or email. */
function Owner({ owner }: { owner: AdminLicenseOwner }) {
  const id = owner.type === "workspace" ? owner.workspaceId : owner.mentraUserId;
  const name = owner.name ?? (owner.type === "person" ? owner.email : null) ?? id;
  const email = owner.type === "person" && owner.name !== null ? owner.email : null;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        {name}
        <span className="bg-surface text-muted-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">
          {owner.type === "workspace" ? "Workspace" : "Person"}
        </span>
      </div>
      {email ? <div className="text-muted-foreground text-xs">{email}</div> : null}
      <code className="text-muted-foreground block truncate text-xs">{id}</code>
    </div>
  );
}

/** A date as the admin reads it. UTC, so the paid-through day is the same wherever the admin is. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
}
