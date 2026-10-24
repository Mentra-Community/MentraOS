import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPERATOR_KEY_SCOPES, ORGANIZATION_CAPABILITIES, type AdminRegistryEntryView, type AdminRegistryRuleView } from "@mentra/workspace-contract";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArchiveRules,
  coverageError,
  coverageText,
  entryTitle,
  NO_FILTERS,
  parseUrlList,
  registerOutcomeText,
  REGISTRY_ENTRIES_QUERY_KEY,
  REGISTRY_RULES_QUERY_KEY,
  registryEntriesPath,
  RegistryListing,
  ruleLabel,
  type RegistryFilters,
} from "./registry";
import { visiblePages, type AdminMe } from "../lib/admin-access";
import { ApiError } from "../lib/api";

// Synthetic entries only. The query cache is seeded, so a server render never reaches the network.
const notes: AdminRegistryEntryView = {
  url: "https://notes.example.com/",
  packageName: "com.example.notes",
  registrableDomain: "example.com",
  name: "Notes",
  version: "1.4.0",
  ageRating: "4+",
  iconUrl: "https://notes.example.com/icon.png",
  verification: "verified",
  private: false,
  status: "active",
  archivedBy: [],
  firstRegisteredAt: "2026-10-01T12:00:00.000Z",
  firstRegisteredBy: "mu_alice",
  lastVerifiedAt: "2026-10-20T12:00:00.000Z",
};
const reported: AdminRegistryEntryView = {
  ...notes,
  url: "https://inventory.globex.com/miniapps/",
  packageName: "com.globex.inventory",
  registrableDomain: "globex.com",
  name: "Inventory",
  iconUrl: null,
  verification: "phone_reported",
  lastVerifiedAt: null,
  firstRegisteredBy: "mu_bob",
};
const privateEntry: AdminRegistryEntryView = {
  ...notes,
  url: "https://tools.acme.com/",
  packageName: "com.acme.tools",
  registrableDomain: "acme.com",
  name: null,
  version: null,
  ageRating: null,
  iconUrl: null,
  verification: "phone_reported",
  private: true,
  lastVerifiedAt: null,
};
const archived: AdminRegistryEntryView = {
  ...notes,
  url: "https://spam.example.net/",
  packageName: "net.example.spam",
  registrableDomain: "example.net",
  name: "Free Gems",
  iconUrl: null,
  status: "archived",
  archivedBy: ["domain"],
};

const rule: AdminRegistryRuleView = {
  kind: "domain",
  value: "example.net",
  reason: "Phishing",
  createdBy: "admin@mentra.glass",
  createdAt: "2026-10-21T09:00:00.000Z",
};

interface Served<T> {
  items: T[];
  next: string | null;
}

const pagesOf = <T,>(pages: Served<T>[]) => ({
  pages,
  pageParams: pages.map((_, index) => (index === 0 ? undefined : pages[index - 1]!.next)),
});

/** The entry list for `filters`, rendered with `pages` in the cache (null: still loading) or `failure` as its error. */
function renderListing(
  pages: Served<AdminRegistryEntryView>[] | null = [{ items: [notes, reported, privateEntry, archived], next: null }],
  options: { filters?: RegistryFilters; failure?: string } = {},
): string {
  const filters = options.filters ?? NO_FILTERS;
  const key = [...REGISTRY_ENTRIES_QUERY_KEY, filters];
  const client = new QueryClient();
  if (pages) client.setQueryData(key, pagesOf(pages));
  if (options.failure) {
    client.setDefaultOptions({ queries: { retry: false, retryOnMount: false } });
    client.getQueryCache().build(client, { queryKey: key }).setState({ status: "error", data: undefined, error: new Error(options.failure), fetchStatus: "idle" });
  }
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RegistryListing filters={filters} onFilters={() => {}} />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

function renderRules(pages: Served<AdminRegistryRuleView>[] | null = [{ items: [rule], next: null }]): string {
  const client = new QueryClient();
  if (pages) client.setQueryData(REGISTRY_RULES_QUERY_KEY, pagesOf(pages));
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ArchiveRules />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

/** The text a person reads, without the markup. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** The text of the table's rows alone: the filters' options say "Verified" and "Active" too. */
const rowsText = (html: string) => textOf(html.match(/<tbody[\s\S]*<\/tbody>/)?.[0] ?? "");

describe("the Miniapp registry page lists every entry", () => {
  test("shows each entry's name, URL, package, source, status and dates", () => {
    const html = renderListing();
    const text = textOf(html);
    expect(text).toContain("All entries");
    expect(text).toContain("Notes");
    expect(text).toContain("https://notes.example.com/");
    expect(text).toContain("com.example.notes");
    expect(text).toContain("Version 1.4.0");
    expect(text).toContain("Verified");
    expect(text).toContain("Active");
    expect(text).toContain("Oct 1, 2026");
    expect(text).toContain("mu_alice");
    expect(text).toContain("Oct 20, 2026");
    for (const column of ["Miniapp", "Package", "Source", "Status", "First registered", "Last verified"]) {
      expect(html).toContain(`>${column}</th>`);
    }
  });

  test("a phone's report shows its host, not its name, and says it is a phone's report", () => {
    const text = rowsText(renderListing([{ items: [reported], next: null }]));
    expect(text).toContain("inventory.globex.com");
    expect(text).toContain("Reported by a phone");
    expect(text).toContain("Reported as Inventory");
    expect(text).toContain("Never");
    expect(text).not.toContain("Verified");
  });

  test("a private entry is tagged Private", () => {
    const text = textOf(renderListing([{ items: [privateEntry], next: null }]));
    expect(text).toContain("tools.acme.com");
    expect(text).toContain("Private");
  });

  test("an archived entry says so, and by which rule", () => {
    const text = rowsText(renderListing([{ items: [archived], next: null }]));
    expect(text).toContain("Archived");
    expect(text).toContain("By domain rule");
    expect(text).not.toContain(" Active ");
  });

  test("the icon comes from the developer's host without a referrer; an entry without one shows a letter", () => {
    const html = renderListing([{ items: [notes, reported], next: null }]);
    const images = [...html.matchAll(/<img[^>]*>/g)].map(match => match[0]);
    expect(images).toHaveLength(1);
    expect(images[0]).toContain('src="https://notes.example.com/icon.png"');
    expect(images[0]).toContain('referrerPolicy="no-referrer"');
    expect(images[0]).toContain('alt=""');
  });

  test("each row offers Archive, which asks in a dialog that isn't there until then", () => {
    const html = renderListing();
    expect(html).toContain('aria-label="Archive Notes"');
    expect(html).toContain('aria-label="Archive inventory.globex.com"');
    expect(html).not.toContain("<dialog");
  });

  test("offers Register URLs, and the export as a download", () => {
    const html = renderListing();
    expect(textOf(html)).toContain("Register URLs");
    expect(html).toMatch(/<a[^>]*href="\/api\/admin\/registry\/export"[^>]*download=""/);
    expect(textOf(html)).toContain("Export CSV");
  });

  test("search, status and source filters", () => {
    const html = renderListing();
    expect(html).toContain('placeholder="URL, package, name, domain or account ID"');
    for (const option of ["All statuses", "Active", "Archived", "All sources", "Verified", "Reported by a phone"]) {
      expect(html).toContain(`>${option}</option>`);
    }
  });

  test("a list still loading, an empty one, a search that finds nothing and a failed one each say so", () => {
    expect(textOf(renderListing(null))).toContain("Loading entries");
    expect(textOf(renderListing([{ items: [], next: null }]))).toContain("No miniapps registered yet.");
    expect(textOf(renderListing([{ items: [], next: null }], { filters: { ...NO_FILTERS, q: "nothing" } }))).toContain("No entries match.");
    const failed = renderListing(null, { failure: "organization.registry.administer is required" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("organization.registry.administer is required");
  });

  test("offers Load more only while Core has another page", () => {
    expect(textOf(renderListing([{ items: [notes], next: "abc" }]))).toContain("Load more");
    expect(textOf(renderListing([{ items: [notes], next: null }]))).not.toContain("Load more");
  });
});

describe("the archive rules", () => {
  test("lists each rule with what it archives, why, who and when, and Unarchive", () => {
    const html = renderRules();
    const text = textOf(html);
    expect(text).toContain("Archive rules");
    expect(text).toContain("Domain");
    expect(text).toContain("example.net");
    expect(text).toContain("Phishing");
    expect(text).toContain("admin@mentra.glass");
    expect(text).toContain("Oct 21, 2026");
    expect(html).toContain('aria-label="Unarchive the domain example.net"');
  });

  test("a rule without a reason says none was given, and no rules says so", () => {
    expect(textOf(renderRules([{ items: [{ ...rule, reason: "" }], next: null }]))).toContain("None given");
    expect(textOf(renderRules([{ items: [], next: null }]))).toContain("No archive rules.");
    expect(textOf(renderRules(null))).toContain("Loading rules");
  });

  test("offers archiving by a rule no entry shows yet", () => {
    const html = renderRules();
    for (const option of ["URL", "Package", "Domain", "Account"]) expect(html).toContain(`>${option}</option>`);
    expect(textOf(html)).toContain("Archive…");
  });
});

describe("the page's words", () => {
  test("ruleLabel names each kind of rule in a sentence", () => {
    expect(ruleLabel({ kind: "url", value: "https://notes.example.com/" })).toBe("the URL https://notes.example.com/");
    expect(ruleLabel({ kind: "package", value: "com.example.notes" })).toBe("the package com.example.notes");
    expect(ruleLabel({ kind: "domain", value: "example.com" })).toBe("the domain example.com");
    expect(ruleLabel({ kind: "account", value: "mu_1" })).toBe("everything account mu_1 registered");
  });

  test("coverageText says how many entries a rule covers", () => {
    expect(coverageText({ entries: 0, activeEntries: 0 })).toBe("No entries match yet.");
    expect(coverageText({ entries: 1, activeEntries: 1 })).toBe("This covers 1 entry.");
    expect(coverageText({ entries: 3, activeEntries: 3 })).toBe("This covers 3 entries.");
    expect(coverageText({ entries: 3, activeEntries: 2 })).toBe("This covers 3 entries, 2 of them active.");
    expect(coverageText({ entries: 2, activeEntries: 0 })).toBe("This covers 2 entries, all archived already.");
  });

  test("coverageError says what Core takes when it refuses a rule's value", () => {
    const refused = new ApiError("not a valid domain archive rule", 400, "invalid_request");
    expect(coverageError({ kind: "domain", value: "notes.example.com" }, refused)).toBe(
      "Core can't archive that domain. Enter a registrable domain, such as example.com, not a subdomain.",
    );
    expect(coverageError({ kind: "url", value: "http://x" }, refused)).toBe("Core can't archive that URL. Enter a miniapp URL that starts with https://.");
    expect(coverageError({ kind: "url", value: "x" }, new Error("Request timed out. Please try again."))).toBe("Request timed out. Please try again.");
  });

  test("registerOutcomeText words each result", () => {
    const input = "https://notes.example.com/";
    expect(registerOutcomeText({ input, result: "accepted", name: "Notes" })).toBe("Registered as Notes.");
    expect(registerOutcomeText({ input, result: "accepted_unverified", name: null })).toBe("Registered, but Core couldn't read its details.");
    expect(registerOutcomeText({ input, result: "not_a_miniapp", reason: "invalid_manifest" })).toBe("Not added. Its miniapp.json is missing or isn't valid.");
    expect(registerOutcomeText({ input, result: "not_a_miniapp", reason: "domain_mismatch" })).toBe("Not added. Its package name doesn't belong to its domain.");
    expect(registerOutcomeText({ input, result: "not_a_miniapp", reason: "not_https" })).toBe("Not added. A miniapp URL must use HTTPS.");
    expect(registerOutcomeText({ input, result: "not_a_miniapp", reason: "something_new" })).toBe("Not added. It isn't a miniapp.");
    expect(registerOutcomeText({ input, result: "unreachable" })).toBe("Not added. Core couldn't reach it.");
    expect(registerOutcomeText({ input, result: "archived" })).toBe("Not added. It's archived.");
    expect(registerOutcomeText({ input, result: "invalid_url" })).toBe("Not added. This isn't a miniapp URL.");
    expect(registerOutcomeText({ input, result: "failed" })).toBe("Something went wrong. Try again.");
  });

  test("parseUrlList takes one URL per line, or separated by spaces", () => {
    expect(parseUrlList("https://a.example.com/\n\n  https://b.example.com/ https://c.example.com/\r\n")).toEqual([
      "https://a.example.com/",
      "https://b.example.com/",
      "https://c.example.com/",
    ]);
    expect(parseUrlList("   \n ")).toEqual([]);
  });

  test("entryTitle is the name of a verified entry and the host otherwise", () => {
    expect(entryTitle(notes)).toBe("Notes");
    expect(entryTitle(reported)).toBe("inventory.globex.com");
    expect(entryTitle(privateEntry)).toBe("tools.acme.com");
    expect(entryTitle({ ...notes, name: null })).toBe("notes.example.com");
  });

  test("registryEntriesPath carries the filters and the cursor, and nothing when there are none", () => {
    expect(registryEntriesPath(NO_FILTERS)).toBe("/api/admin/registry/entries");
    expect(registryEntriesPath({ q: "  notes & co ", status: "archived", verification: "phone_reported" }, "abc")).toBe(
      "/api/admin/registry/entries?q=notes+%26+co&status=archived&verification=phone_reported&cursor=abc",
    );
  });

  test("says miniapp as one word, and never Mini App or the Store", () => {
    const text = textOf(renderListing()) + textOf(renderRules());
    expect(text).not.toMatch(/mini[- ]app/i);
    expect(text).not.toMatch(/\bstore\b/i);
  });
});

describe("the Miniapp registry item in the admin portal's navigation", () => {
  // App.tsx reads the address bar when it is imported, so it needs a window for that one moment.
  async function loadNav() {
    const scope = globalThis as { window?: unknown };
    scope.window = { location: { search: "", hostname: "localhost", href: "http://localhost/", pathname: "/" } };
    try {
      return await import("../App");
    } finally {
      delete scope.window;
    }
  }

  const caller = (capabilities: AdminMe["organization"]["capabilities"], isOrganizationAdmin: boolean): AdminMe => ({
    authenticated: true,
    user: isOrganizationAdmin ? { mentraUserId: "mu_ada", email: "ada@acme.test", emailVerified: true, isOrganizationAdmin } : null,
    credential: isOrganizationAdmin ? null : { credentialId: "cred_1", credentialKind: "organization", label: "Triage bot" },
    organization: { capabilities },
    workspaces: [],
  });

  test("is offered to an Organization Admin, labelled Miniapp registry, after Workspaces", async () => {
    const { visibleNav } = await loadNav();
    const nav = visibleNav(visiblePages(caller([...ORGANIZATION_CAPABILITIES], true)));
    expect(nav.find(item => item.key === "registry")?.label).toBe("Miniapp registry");
    expect(nav.map(item => item.key).indexOf("registry")).toBe(nav.map(item => item.key).indexOf("workspaces") + 1);
  });

  test("is never offered to an operator key, whatever its scopes", async () => {
    const { visibleNav } = await loadNav();
    expect(visibleNav(visiblePages(caller([...OPERATOR_KEY_SCOPES], false))).map(item => item.key)).not.toContain("registry");
  });
});
