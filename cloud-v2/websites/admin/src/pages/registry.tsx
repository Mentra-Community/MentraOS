import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ADMIN_REGISTRY_REASON_MAX_LENGTH,
  ADMIN_REGISTRY_REGISTER_MAX_URLS,
  ADMIN_REGISTRY_RULE_KINDS,
  type AdminRegistryArchiveResponse,
  type AdminRegistryCoverage,
  type AdminRegistryEntriesResponse,
  type AdminRegistryEntryView,
  type AdminRegistryRegisterResponse,
  type AdminRegistryRegisterResult,
  type AdminRegistryRule,
  type AdminRegistryRuleKind,
  type AdminRegistryRulesResponse,
  type AdminRegistryRuleView,
  type AdminRegistryUnarchiveResponse,
} from "@mentra/workspace-contract";
import {
  Badge,
  Button,
  buttonVariants,
  ConfirmDialog,
  Dialog,
  Input,
  Label,
  NativeSelect,
  Spinner,
  Textarea,
  useAsking,
} from "@mentra/workspace-ui";
import { Download, RefreshCcw } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

/** The shared workspace screens' card (Mentra's tokens, from @mentra/workspace-ui/mentra.css). */
const PANEL = "rounded-card border bg-card";
const BASE = "/api/admin/registry";

/** The entry list's query key. The filters follow it, so each search is its own cached list. */
export const REGISTRY_ENTRIES_QUERY_KEY = ["admin-registry-entries"] as const;
export const REGISTRY_RULES_QUERY_KEY = ["admin-registry-rules"] as const;
export const REGISTRY_EXPORT_PATH = `${BASE}/export`;

/** What the list is filtered by. Empty strings are "all". */
export interface RegistryFilters {
  q: string;
  status: "" | "active" | "archived";
  verification: "" | "verified" | "phone_reported";
}

export const NO_FILTERS: RegistryFilters = { q: "", status: "", verification: "" };

/** `GET /api/admin/registry/entries` for the filters and the cursor of the page after the one already read. */
export function registryEntriesPath(filters: RegistryFilters, cursor?: string): string {
  const params = new URLSearchParams();
  const text = filters.q.trim();
  if (text) params.set("q", text);
  if (filters.status) params.set("status", filters.status);
  if (filters.verification) params.set("verification", filters.verification);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return search ? `${BASE}/entries?${search}` : `${BASE}/entries`;
}

// --- Words -------------------------------------------------------------------

const KIND_NAMES: Record<AdminRegistryRuleKind, string> = {
  url: "URL",
  package: "Package",
  domain: "Domain",
  account: "Account",
};

/** A rule in a sentence: "the domain example.com", "everything account mu_1 registered". */
export function ruleLabel(rule: AdminRegistryRule): string {
  switch (rule.kind) {
    case "url":
      return `the URL ${rule.value}`;
    case "package":
      return `the package ${rule.value}`;
    case "domain":
      return `the domain ${rule.value}`;
    case "account":
      return `everything account ${rule.value} registered`;
  }
}

/** What archiving one entry by each kind of rule names, in the dialog's list. */
function choiceLabel(kind: AdminRegistryRuleKind): string {
  switch (kind) {
    case "url":
      return "This URL";
    case "package":
      return "Its package";
    case "domain":
      return "Its domain";
    case "account":
      return "Everything the account that registered it registered";
  }
}

const KIND_NOUNS: Record<AdminRegistryRuleKind, string> = {
  url: "URL",
  package: "package name",
  domain: "domain",
  account: "account ID",
};

/** What Core takes for each kind of rule, for a value it refused. */
const KIND_HINTS: Record<AdminRegistryRuleKind, string> = {
  url: "Enter a miniapp URL that starts with https://.",
  package: "Enter a package name, such as com.example.notes.",
  domain: "Enter a registrable domain, such as example.com, not a subdomain.",
  account: "Enter a Mentra user ID.",
};

/** Why the coverage of `rule` couldn't be counted, in words. */
export function coverageError(rule: AdminRegistryRule, error: unknown): string {
  if (error instanceof ApiError && error.status === 400) return `Core can't archive that ${KIND_NOUNS[rule.kind]}. ${KIND_HINTS[rule.kind]}`;
  return error instanceof Error ? error.message : "Couldn't count the entries.";
}

/** How many entries a rule covers, in words. */
export function coverageText(coverage: Pick<AdminRegistryCoverage, "entries" | "activeEntries">): string {
  if (coverage.entries === 0) return "No entries match yet.";
  const entries = coverage.entries === 1 ? "1 entry" : `${coverage.entries} entries`;
  if (coverage.activeEntries === coverage.entries) return `This covers ${entries}.`;
  if (coverage.activeEntries === 0) return `This covers ${entries}, all archived already.`;
  return `This covers ${entries}, ${coverage.activeEntries} of them active.`;
}

const NOT_A_MINIAPP: Record<string, string> = {
  invalid_manifest: "Not added. Its miniapp.json is missing or isn't valid.",
  domain_mismatch: "Not added. Its package name doesn't belong to its domain.",
  not_https: "Not added. A miniapp URL must use HTTPS.",
  local_network_url: "Not added. URLs on a local network aren't registered.",
};

/** What registering one URL came to, in words. */
export function registerOutcomeText(result: AdminRegistryRegisterResult): string {
  switch (result.result) {
    case "accepted":
      return `Registered${result.name ? ` as ${result.name}` : ""}.`;
    case "accepted_unverified":
      return "Registered, but Core couldn't read its details.";
    case "not_a_miniapp":
      return NOT_A_MINIAPP[result.reason ?? ""] ?? "Not added. It isn't a miniapp.";
    case "unreachable":
      return "Not added. Core couldn't reach it.";
    case "archived":
      return "Not added. It's archived.";
    case "invalid_url":
      return "Not added. This isn't a miniapp URL.";
    case "failed":
      return "Something went wrong. Try again.";
  }
}

/** The URLs in a pasted list: one per line, or separated by spaces. */
export function parseUrlList(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** An entry's title: its name, or its host for an entry a phone reported (Core shows no developer text for one). */
export function entryTitle(entry: Pick<AdminRegistryEntryView, "url" | "name" | "verification">): string {
  if (entry.verification === "verified" && entry.name) return entry.name;
  try {
    return new URL(entry.url).host;
  } catch {
    return entry.url;
  }
}

// --- The page ----------------------------------------------------------------

/**
 * Every miniapp URL the Mentra App has installed, for Organization Admins. Archiving asks first and says how many
 * entries it covers; the archive rules are listed with Unarchive; Register URLs adds URLs as the admin.
 */
export function RegistryPage() {
  const [filters, setFilters] = useState<RegistryFilters>(NO_FILTERS);
  return (
    <div className="space-y-6">
      <RegistryListing filters={filters} onFilters={setFilters} />
      <ArchiveRules />
    </div>
  );
}

const STATUS_OPTIONS: ReadonlyArray<readonly [RegistryFilters["status"], string]> = [
  ["", "All statuses"],
  ["active", "Active"],
  ["archived", "Archived"],
];
const SOURCE_OPTIONS: ReadonlyArray<readonly [RegistryFilters["verification"], string]> = [
  ["", "All sources"],
  ["verified", "Verified"],
  ["phone_reported", "Reported by a phone"],
];

/** The entry list for `filters`. `onFilters` is told what to search for when the form is submitted. */
export function RegistryListing({ filters, onFilters }: { filters: RegistryFilters; onFilters(filters: RegistryFilters): void }) {
  const [draft, setDraft] = useState(filters);
  const [registering, setRegistering] = useState(false);
  const searchId = useId();
  const statusId = useId();
  const sourceId = useId();
  const entries = useInfiniteQuery({
    queryKey: [...REGISTRY_ENTRIES_QUERY_KEY, filters],
    queryFn: ({ pageParam }) => api<AdminRegistryEntriesResponse>(registryEntriesPath(filters, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const rows = entries.data?.pages.flatMap(page => page.items);
  const filtered = filters.q.trim() !== "" || filters.status !== "" || filters.verification !== "";

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onFilters({ ...draft, q: draft.q.trim() });
  }

  return (
    <section className={PANEL}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-6">
        <div>
          <h2 className="text-xl font-semibold">All entries</h2>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">
            Most recently registered first. Archiving stops new installs and updates. Copies already installed keep running.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setRegistering(true)}>
            Register URLs
          </Button>
          <a className={buttonVariants({ variant: "secondary", size: "sm" })} href={REGISTRY_EXPORT_PATH} download>
            <Download className="size-4" /> Export CSV
          </a>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh entries"
            disabled={entries.isFetching}
            onClick={() => void entries.refetch()}
          >
            <RefreshCcw className={`size-4 ${entries.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <form onSubmit={search} className="flex flex-wrap items-end gap-3 border-b px-6 py-4">
        <div className="grid gap-2">
          <Label htmlFor={searchId}>Search</Label>
          <Input
            id={searchId}
            type="search"
            autoComplete="off"
            maxLength={200}
            placeholder="URL, package, name, domain or account ID"
            className="w-96"
            value={draft.q}
            onChange={event => setDraft({ ...draft, q: event.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={statusId}>Status</Label>
          <NativeSelect
            id={statusId}
            value={draft.status}
            onChange={event => setDraft({ ...draft, status: event.target.value as RegistryFilters["status"] })}
          >
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={sourceId}>Source</Label>
          <NativeSelect
            id={sourceId}
            value={draft.verification}
            onChange={event => setDraft({ ...draft, verification: event.target.value as RegistryFilters["verification"] })}
          >
            {SOURCE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {rows === undefined && entries.isError ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground m-6 px-4 py-3 text-sm">
          {entries.error instanceof Error ? entries.error.message : "Request failed"}
        </p>
      ) : rows === undefined ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 p-6 text-sm">
          <Spinner /> Loading entries
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">{filtered ? "No entries match." : "No miniapps registered yet."}</p>
      ) : (
        <EntryTable entries={rows} />
      )}

      {entries.hasNextPage ? (
        <div className="border-t px-6 py-4">
          <Button type="button" variant="secondary" size="sm" disabled={entries.isFetchingNextPage} onClick={() => void entries.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}

      {registering ? <RegisterDialog onClose={() => setRegistering(false)} /> : null}
    </section>
  );
}

function EntryTable({ entries }: { entries: AdminRegistryEntryView[] }) {
  const ask = useAsking<AdminRegistryEntryView>(entry => entry.url);
  const asking = ask.asking;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            <th className="px-6 py-3 font-medium">Miniapp</th>
            <th className="py-3 pr-4 font-medium">Package</th>
            <th className="py-3 pr-4 font-medium">Source</th>
            <th className="py-3 pr-4 font-medium">Status</th>
            <th className="py-3 pr-4 font-medium">First registered</th>
            <th className="py-3 pr-4 font-medium">Last verified</th>
            <th className="py-3 pr-6 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y border-t">
          {entries.map(entry => {
            const title = entryTitle(entry);
            return (
              <tr key={entry.url} className="align-top">
                <td className="px-6 py-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <EntryIcon entry={entry} />
                    <div className="min-w-0">
                      <div className="font-semibold">{title}</div>
                      <code className="text-muted-foreground block max-w-60 truncate text-xs" title={entry.url}>
                        {entry.url}
                      </code>
                      {entry.verification === "phone_reported" && entry.name ? (
                        <div className="text-muted-foreground mt-0.5 text-xs">Reported as {entry.name}</div>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td className="py-3 pr-4">
                  <code className="text-xs">{entry.packageName}</code>
                  {entry.version ? <div className="text-muted-foreground text-xs">Version {entry.version}</div> : null}
                </td>
                <td className="py-3 pr-4">
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={entry.verification === "verified" ? "success" : "neutral"}>
                      {entry.verification === "verified" ? "Verified" : "Reported by a phone"}
                    </Badge>
                    {entry.private ? <Badge>Private</Badge> : null}
                  </div>
                </td>
                <td className="py-3 pr-4">
                  <StatusLabel entry={entry} />
                </td>
                <td className="py-3 pr-4 whitespace-nowrap">
                  <div title={entry.firstRegisteredAt}>{formatDate(entry.firstRegisteredAt)}</div>
                  <code className="text-muted-foreground text-xs" title="The account that registered it">
                    {entry.firstRegisteredBy}
                  </code>
                </td>
                <td className="py-3 pr-4 whitespace-nowrap">{entry.lastVerifiedAt ? <span title={entry.lastVerifiedAt}>{formatDate(entry.lastVerifiedAt)}</span> : "Never"}</td>
                <td className="py-3 pr-6 text-right">
                  <Button
                    ref={ask.trigger(entry.url)}
                    type="button"
                    variant="destructive-secondary"
                    size="sm"
                    aria-label={`Archive ${title}`}
                    onClick={() => ask.ask(entry)}
                  >
                    Archive
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {asking ? (
        <ArchiveDialog
          title={`Archive ${entryTitle(asking)}?`}
          choices={ADMIN_REGISTRY_RULE_KINDS.map(kind => ({ kind, value: ruleValueFor(asking, kind) }))}
          // The row stays either way, so focus goes back to its Archive button.
          onClose={() => ask.close(false)}
        />
      ) : null}
    </div>
  );
}

/** The value an entry's rule of `kind` names. */
function ruleValueFor(entry: AdminRegistryEntryView, kind: AdminRegistryRuleKind): string {
  switch (kind) {
    case "url":
      return entry.url;
    case "package":
      return entry.packageName;
    case "domain":
      return entry.registrableDomain;
    case "account":
      return entry.firstRegisteredBy;
  }
}

/**
 * The manifest's icon, from the developer's host: the browser loads it without a referrer. An entry with none (a
 * phone's report, a private one) shows its title's first letter.
 */
function EntryIcon({ entry }: { entry: AdminRegistryEntryView }) {
  if (entry.iconUrl) {
    return <img src={entry.iconUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="bg-surface size-9 shrink-0 rounded-[10px] border object-cover" />;
  }
  return (
    <span aria-hidden="true" className="bg-surface text-muted-foreground grid size-9 shrink-0 place-items-center rounded-[10px] border text-sm font-semibold uppercase">
      {entryTitle(entry).slice(0, 1)}
    </span>
  );
}

function StatusLabel({ entry }: { entry: AdminRegistryEntryView }) {
  if (entry.status === "active") return <span className="bg-info text-info-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Active</span>;
  return (
    <div>
      <span className="bg-error text-error-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Archived</span>
      {entry.archivedBy.length > 0 ? (
        <div className="text-muted-foreground mt-1 text-xs">By {entry.archivedBy.map(kind => KIND_NAMES[kind].toLowerCase()).join(", ")} rule</div>
      ) : null}
    </div>
  );
}

// --- Archiving ---------------------------------------------------------------

async function invalidateRegistry(client: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    client.invalidateQueries({ queryKey: REGISTRY_ENTRIES_QUERY_KEY }),
    client.invalidateQueries({ queryKey: REGISTRY_RULES_QUERY_KEY }),
  ]);
}

/**
 * Asks before archiving: which rule (when there is a choice), how many entries it covers today, and an optional
 * reason. Archive sends the request; a refusal is shown in the dialog, which stays open for another try.
 */
export function ArchiveDialog({
  title,
  choices,
  onClose,
}: {
  title: string;
  /** The rules to choose from: one entry's URL, package, domain and account, or the one rule the form names. */
  choices: readonly AdminRegistryRule[];
  /** `done` when the rule was made, false when the person backed out. */
  onClose(done: boolean): void;
}) {
  const client = useQueryClient();
  const [chosen, setChosen] = useState(0);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const reasonId = useId();
  const rule = choices[chosen]!;
  const coverage = useQuery({
    queryKey: ["admin-registry-coverage", rule.kind, rule.value],
    queryFn: () => api<AdminRegistryCoverage>(`${BASE}/coverage?${new URLSearchParams({ kind: rule.kind, value: rule.value })}`),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const archive = useMutation({
    mutationFn: () =>
      api<AdminRegistryArchiveResponse>(`${BASE}/archive`, { method: "POST", body: { rule, reason: reason.trim() || undefined } }),
    gcTime: 0,
  });
  const pending = archive.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !coverage.data) return;
    setRefusal(null);
    try {
      await archive.mutateAsync();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : "Something went wrong. Try again.");
      return;
    }
    await invalidateRegistry(client);
    onClose(true);
  }

  return (
    <Dialog open onClose={() => onClose(false)} locked={pending} title={title} description="Phones can't install what it covers, and installed copies stop getting updates but keep running. URLs registered later that match are refused too.">
      <form onSubmit={submit} className="space-y-5">
        {choices.length > 1 ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">Archive by</legend>
            {choices.map((choice, index) => (
              <label key={choice.kind} className="flex items-start gap-2.5 text-sm">
                <input
                  type="radio"
                  name="archive-rule"
                  value={choice.kind}
                  className="mt-0.5 size-4 accent-[#087d50]"
                  checked={index === chosen}
                  disabled={pending}
                  onChange={() => setChosen(index)}
                />
                <span className="min-w-0">
                  <span className="block">{choiceLabel(choice.kind)}</span>
                  <code className="text-muted-foreground block truncate text-xs">{choice.value}</code>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div role="status" className="text-sm">
          {coverage.isError ? (
            <span className="text-destructive">{coverageError(rule, coverage.error)}</span>
          ) : coverage.data ? (
            <>
              <span className="font-semibold">{coverageText(coverage.data)}</span>
              {coverage.data.exists ? <span className="text-muted-foreground"> This rule exists already.</span> : null}
            </>
          ) : (
            <span className="text-muted-foreground inline-flex items-center gap-2">
              <Spinner /> Counting entries
            </span>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={reasonId}>Reason (optional)</Label>
          <Input
            id={reasonId}
            autoComplete="off"
            maxLength={ADMIN_REGISTRY_REASON_MAX_LENGTH}
            placeholder="Shown with the rule"
            disabled={pending}
            value={reason}
            onChange={event => setReason(event.target.value)}
          />
        </div>
        {refusal !== null ? (
          <p role="alert" className="rounded-notice bg-surface px-4 py-3 text-sm">
            {refusal}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button type="button" variant="secondary" disabled={pending} onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={pending || !coverage.data} aria-busy={pending || undefined}>
            Archive
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The archive rules, newest first, each with Unarchive, and a form for archiving by a rule no entry shows. */
export function ArchiveRules() {
  const client = useQueryClient();
  const rules = useInfiniteQuery({
    queryKey: REGISTRY_RULES_QUERY_KEY,
    queryFn: ({ pageParam }) =>
      api<AdminRegistryRulesResponse>(pageParam ? `${BASE}/rules?cursor=${encodeURIComponent(pageParam)}` : `${BASE}/rules`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
  });
  const items = rules.data?.pages.flatMap(page => page.items);
  const ask = useAsking<AdminRegistryRuleView>(rule => `${rule.kind}:${rule.value}`);
  const asking = ask.asking;
  const [adding, setAdding] = useState<AdminRegistryRule | null>(null);

  return (
    <section className={PANEL}>
      <div className="border-b p-6">
        <h2 className="text-xl font-semibold">Archive rules</h2>
        <p className="text-muted-foreground mt-1 max-w-xl text-sm">
          Each rule archives what it names, including URLs registered after it. Unarchive a rule to let phones install and
          update what it covers again, unless another rule covers it.
        </p>
      </div>
      <AddRuleForm onArchive={setAdding} />
      {items === undefined && rules.isError ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground m-6 px-4 py-3 text-sm">
          {rules.error instanceof Error ? rules.error.message : "Request failed"}
        </p>
      ) : items === undefined ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 p-6 text-sm">
          <Spinner /> Loading rules
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground border-t p-6 text-sm">No archive rules.</p>
      ) : (
        <div className="overflow-x-auto border-t">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr>
                <th className="px-6 py-3 font-medium">Archives</th>
                <th className="py-3 pr-4 font-medium">Reason</th>
                <th className="py-3 pr-4 font-medium">Archived by</th>
                <th className="py-3 pr-4 font-medium">Date</th>
                <th className="py-3 pr-6 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y border-t">
              {items.map(rule => {
                const id = `${rule.kind}:${rule.value}`;
                return (
                  <tr key={id} className="align-top">
                    <td className="px-6 py-3">
                      <div className="text-muted-foreground text-xs font-semibold">{KIND_NAMES[rule.kind]}</div>
                      <code className="block max-w-96 truncate text-xs" title={rule.value}>
                        {rule.value}
                      </code>
                    </td>
                    <td className="py-3 pr-4">{rule.reason || <span className="text-muted-foreground">None given</span>}</td>
                    <td className="py-3 pr-4">{rule.createdBy}</td>
                    <td className="py-3 pr-4 whitespace-nowrap" title={rule.createdAt}>
                      {formatDate(rule.createdAt)}
                    </td>
                    <td className="py-3 pr-6 text-right">
                      <Button
                        ref={ask.trigger(id)}
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={`Unarchive ${ruleLabel(rule)}`}
                        onClick={() => ask.ask(rule, items)}
                      >
                        Unarchive
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rules.hasNextPage ? (
        <div className="border-t px-6 py-4">
          <Button type="button" variant="secondary" size="sm" disabled={rules.isFetchingNextPage} onClick={() => void rules.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
      {asking ? (
        <ConfirmDialog
          title={`Unarchive ${ruleLabel(asking)}?`}
          description="Phones can install and update what it covers again, unless another rule covers it."
          cancelLabel="Cancel"
          confirmLabel="Unarchive"
          onConfirm={async () => {
            try {
              await api<AdminRegistryUnarchiveResponse>(`${BASE}/unarchive`, {
                method: "POST",
                body: { rule: { kind: asking.kind, value: asking.value } },
              });
            } catch (error) {
              return error instanceof Error ? error.message : "Something went wrong. Try again.";
            }
            await invalidateRegistry(client);
            return null;
          }}
          onClose={ask.close}
        />
      ) : null}
      {adding ? <ArchiveDialog title={`Archive ${ruleLabel(adding)}?`} choices={[adding]} onClose={() => setAdding(null)} /> : null}
    </section>
  );
}

const KIND_PLACEHOLDERS: Record<AdminRegistryRuleKind, string> = {
  url: "https://miniapp.example.com/",
  package: "com.example.miniapp",
  domain: "example.com",
  account: "Mentra user ID",
};

/** A rule by hand: for a domain, a package or an account before any of its URLs is registered. */
function AddRuleForm({ onArchive }: { onArchive(rule: AdminRegistryRule): void }) {
  const [kind, setKind] = useState<AdminRegistryRuleKind>("domain");
  const [value, setValue] = useState("");
  const kindId = useId();
  const valueId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onArchive({ kind, value: trimmed });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 px-6 py-4">
      <div className="grid gap-2">
        <Label htmlFor={kindId}>Archive by</Label>
        <NativeSelect id={kindId} value={kind} onChange={event => setKind(event.target.value as AdminRegistryRuleKind)}>
          {ADMIN_REGISTRY_RULE_KINDS.map(option => (
            <option key={option} value={option}>
              {KIND_NAMES[option]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={valueId}>{KIND_NAMES[kind]}</Label>
        <Input
          id={valueId}
          autoComplete="off"
          maxLength={2048}
          placeholder={KIND_PLACEHOLDERS[kind]}
          className="w-80"
          value={value}
          onChange={event => setValue(event.target.value)}
        />
      </div>
      <Button type="submit" variant="destructive-secondary" disabled={!value.trim()}>
        Archive…
      </Button>
    </form>
  );
}

// --- Registering -------------------------------------------------------------

/**
 * Registers a list of miniapp URLs as the signed-in Organization Admin: Core reads each one as it does when a phone
 * installs it. The results stay in the dialog until Done.
 */
export function RegisterDialog({ onClose }: { onClose(): void }) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const fieldId = useId();
  const register = useMutation({
    mutationFn: (urls: string[]) => api<AdminRegistryRegisterResponse>(`${BASE}/register`, { method: "POST", body: { urls } }),
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: REGISTRY_ENTRIES_QUERY_KEY }),
  });
  const results = register.data?.results;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const urls = parseUrlList(text);
    if (urls.length === 0) return setFormError("Enter at least one miniapp URL.");
    if (new Set(urls).size > ADMIN_REGISTRY_REGISTER_MAX_URLS) return setFormError(`Enter up to ${ADMIN_REGISTRY_REGISTER_MAX_URLS} URLs at a time.`);
    setFormError(null);
    register.mutate(urls);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={register.isPending}
      className="max-w-xl"
      title="Register URLs"
      description="Core reads each URL's miniapp.json, as it does when a phone installs it, and records it as registered by you."
    >
      {results ? (
        <div className="space-y-5">
          <ul className="divide-y rounded-[16px] border" aria-label="Results">
            {results.map(result => (
              <li key={result.input} className="px-4 py-3 text-sm">
                <code className="block truncate text-xs" title={result.input}>
                  {result.input.trim()}
                </code>
                <span className={result.result === "accepted" ? "font-semibold" : "text-muted-foreground"}>{registerOutcomeText(result)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => register.reset()}>
              Register more
            </Button>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-2">
            <Label htmlFor={fieldId}>Miniapp URLs, one per line (up to {ADMIN_REGISTRY_REGISTER_MAX_URLS})</Label>
            <Textarea
              id={fieldId}
              rows={6}
              spellCheck={false}
              placeholder={"https://miniapps.example.com/notes/\nhttps://tools.example.com/"}
              disabled={register.isPending}
              value={text}
              onChange={event => setText(event.target.value)}
            />
          </div>
          {formError ? (
            <p role="alert" className="rounded-notice bg-surface px-4 py-3 text-sm">
              {formError}
            </p>
          ) : null}
          {register.isError ? (
            <p role="alert" className="rounded-notice bg-surface px-4 py-3 text-sm">
              {register.error instanceof Error ? register.error.message : "Something went wrong. Try again."}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="button" variant="secondary" disabled={register.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={register.isPending} aria-busy={register.isPending || undefined}>
              {register.isPending ? <Spinner /> : null} Register
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { dateStyle: "medium" });
}
