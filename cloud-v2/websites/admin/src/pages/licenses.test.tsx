import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ORGANIZATION_CAPABILITIES, type AdminLicenseView } from "@mentra/workspace-contract";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { visiblePages, type AdminMe } from "../lib/admin-access";
import { LICENSES_QUERY_KEY, LicenseListing, licensesPath, licenseState } from "./licenses";

// Synthetic owners only. The query cache is seeded, so a server render never reaches the network.
const NOW = Date.parse("2026-10-20T12:00:00Z");

const base = {
  product: "mentra.call.unlimited",
  validFrom: "2026-01-01T00:00:00.000Z",
  paidThrough: "2099-01-31T00:00:00.000Z",
  endedAt: null,
  endedReason: null,
} as const;

const workspaceLicense: AdminLicenseView = {
  ...base,
  licenseId: "lic_workspace",
  owner: { type: "workspace", workspaceId: "ws_acme", name: "Acme Robotics" },
  quantity: 10,
  seatsUsed: 4,
};
const namedPerson: AdminLicenseView = {
  ...base,
  licenseId: "lic_named",
  owner: { type: "person", mentraUserId: "mu_ada", name: "Ada Lovelace", email: "ada@analytical.test" },
  quantity: 1,
  seatsUsed: 1,
};
const emailOnlyPerson: AdminLicenseView = {
  ...base,
  licenseId: "lic_email",
  owner: { type: "person", mentraUserId: "mu_grace", name: null, email: "grace@navy.test" },
  quantity: 1,
  seatsUsed: 1,
};
const anonymousPerson: AdminLicenseView = {
  ...base,
  licenseId: "lic_anonymous",
  owner: { type: "person", mentraUserId: "mu_unknown", name: null, email: null },
  quantity: 1,
  seatsUsed: 1,
};
const unnamedWorkspace: AdminLicenseView = {
  ...base,
  licenseId: "lic_unnamed",
  owner: { type: "workspace", workspaceId: "ws_unnamed", name: null },
  quantity: 3,
  seatsUsed: 0,
};
const expired: AdminLicenseView = { ...workspaceLicense, licenseId: "lic_expired", paidThrough: "2020-03-15T00:00:00.000Z" };
const ended: AdminLicenseView = {
  ...workspaceLicense,
  licenseId: "lic_ended",
  endedAt: "2026-09-01T00:00:00.000Z",
  endedReason: "workspace_deleted",
};
const endedPerson: AdminLicenseView = {
  ...namedPerson,
  licenseId: "lic_ended_person",
  endedAt: "2026-09-02T00:00:00.000Z",
  endedReason: "account_deleted",
};

const everyLicense = [workspaceLicense, namedPerson, emailOnlyPerson, anonymousPerson, unnamedWorkspace, expired, ended, endedPerson];

interface Served {
  items: AdminLicenseView[];
  next: string | null;
}

/** The list for `query`, rendered with `pages` already in the cache (null: still loading) or with `failure` as its error. */
function mount(pages: Served[] | null, options: { query?: string; failure?: string } = {}) {
  const query = options.query ?? "";
  const key = [...LICENSES_QUERY_KEY, query];
  const client = new QueryClient();
  if (pages) client.setQueryData(key, { pages, pageParams: pages.map((_, index) => (index === 0 ? undefined : pages[index - 1]!.next)) });
  if (options.failure) {
    // A failed list is not asked for again on mount, so the failure is what renders.
    client.setDefaultOptions({ queries: { retry: false, retryOnMount: false } });
    client.getQueryCache().build(client, { queryKey: key }).setState({ status: "error", data: undefined, error: new Error(options.failure), fetchStatus: "idle" });
  }
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LicenseListing query={query} onSearch={() => {}} />
      </QueryClientProvider>,
    );
    return { client, html };
  } catch (error) {
    client.clear();
    throw error;
  }
}

/** The markup alone, for a test with nothing else to ask of the cache. */
function render(pages: Served[] | null = [{ items: everyLicense, next: null }], options: { query?: string; failure?: string } = {}): string {
  const { client, html } = mount(pages, options);
  client.clear();
  return html;
}

describe("the Licenses page lists every license", () => {
  test("shows a workspace owner by its name and a person owner by name and email", () => {
    const markup = render();
    expect(markup).toContain("Acme Robotics");
    // Each row is a product a workspace or a person pays for; its Assigned column counts licenses.
    expect(markup).toContain("All products");
    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("ada@analytical.test");
    // A person with an email but no name is shown by the email.
    expect(markup).toContain("grace@navy.test");
    expect(markup).toContain("Workspace");
    expect(markup).toContain("Person");
  });

  test("falls back to the owner's id when Core knows no name or email for it", () => {
    const markup = render([{ items: [anonymousPerson, unnamedWorkspace], next: null }]);
    expect(markup).toContain("mu_unknown");
    expect(markup).toContain("ws_unnamed");
  });

  test("shows the product, the licenses assigned of the quantity, and the paid-through date", () => {
    const markup = render([{ items: [workspaceLicense, namedPerson], next: null }]);
    expect(markup).toContain("mentra.call.unlimited");
    expect(markup).toMatch(/4(<!-- --> of <!-- -->| of )10/);
    expect(markup).toMatch(/1(<!-- --> of <!-- -->| of )1</);
    expect(markup).toContain("Jan 31, 2099");
    // The column counts the licenses assigned: a license is one person's right to a product, and "seat" is not a word anyone reads.
    expect(markup).toContain(">Assigned</th>");
    expect(markup).not.toMatch(/\bseats?\b/i);
  });

  test("says which licenses are active, expired or ended and why", () => {
    const markup = render([{ items: [workspaceLicense, expired, ended, endedPerson], next: null }]);
    expect(markup).toContain("Active");
    expect(markup).toContain("Expired");
    expect(markup).toContain("Ended: workspace deleted");
    expect(markup).toContain("Ended: account deleted");
  });

  test("licenseState: an ended license is ended whatever it was paid through; otherwise paid-through decides", () => {
    expect(licenseState(workspaceLicense, NOW)).toEqual({ kind: "active", label: "Active" });
    expect(licenseState(expired, NOW)).toEqual({ kind: "expired", label: "Expired" });
    expect(licenseState(ended, NOW)).toEqual({ kind: "ended", label: "Ended: workspace deleted" });
    expect(licenseState(endedPerson, NOW)).toEqual({ kind: "ended", label: "Ended: account deleted" });
    expect(licenseState({ ...ended, endedReason: null }, NOW)).toEqual({ kind: "ended", label: "Ended" });
    // The paid-through instant itself is already over.
    expect(licenseState({ ...workspaceLicense, paidThrough: new Date(NOW).toISOString() }, NOW).kind).toBe("expired");
  });

  test("licenseState: a license is active only inside its term, validFrom <= now < paidThrough", () => {
    const later = new Date(NOW + 86_400_000).toISOString();
    // Paid through the future but not started: it grants nothing yet.
    expect(licenseState({ ...workspaceLicense, validFrom: later }, NOW)).toEqual({ kind: "upcoming", label: "Not started" });
    // Starting this instant is in term.
    expect(licenseState({ ...workspaceLicense, validFrom: new Date(NOW).toISOString() }, NOW).kind).toBe("active");
    // A zero-length term never contains an instant, so a future one is never valid.
    expect(licenseState({ ...workspaceLicense, validFrom: later, paidThrough: later }, NOW).kind).toBe("expired");
    // Ended wins over every term.
    expect(licenseState({ ...ended, validFrom: later }, NOW).kind).toBe("ended");
  });

  test("the list says a license that has not started is not started", () => {
    const upcoming: AdminLicenseView = { ...workspaceLicense, licenseId: "lic_upcoming", validFrom: "2098-01-01T00:00:00.000Z" };
    const markup = render([{ items: [upcoming], next: null }]);
    expect(markup).toContain("Not started");
    expect(markup).not.toContain(">Active<");
  });

  test("a list still loading, an empty one and a failed one each say so", () => {
    expect(render(null)).toContain("Loading products");
    expect(render([{ items: [], next: null }])).toContain("No products yet.");
    const failed = render(null, { failure: "organization.licenses.read is required" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("organization.licenses.read is required");
  });

  test("a search that finds nothing says so, and the search box holds the text searched for", () => {
    const markup = render([{ items: [], next: null }], { query: "nobody" });
    expect(markup).toContain("No products match &quot;nobody&quot;.");
    expect(markup).toMatch(/<input[^>]*value="nobody"/);
  });

  test("offers Load more only while Core has another page", () => {
    expect(render([{ items: [workspaceLicense], next: "lic_workspace" }])).toContain("Load more");
    expect(render([{ items: [workspaceLicense], next: null }])).not.toContain("Load more");
  });
});

describe("the Licenses page offers no license change or payment", () => {
  test("its only controls are search, refresh and load more", () => {
    const markup = render([{ items: everyLicense, next: "lic_next" }]);
    const buttons = [...markup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(
      match => match[1]!.replace(/<[^>]+>/g, "").trim() || (match[0].match(/aria-label="([^"]*)"/)?.[1] ?? ""),
    );
    expect(buttons.sort()).toEqual(["Load more", "Refresh products", "Search"]);
    // A search form only filters the list; there is no link out and no other field.
    expect(markup).not.toContain("<a ");
    expect(markup.match(/<input/g)).toHaveLength(1);
    expect(markup.match(/<form/g)).toHaveLength(1);
    for (const element of ["<select", "<textarea"]) expect(markup).not.toContain(element);
  });

  test("never names an action on licenses or money", () => {
    const text = render([{ items: everyLicense, next: "lic_next" }]).replace(/<[^>]+>/g, " ");
    // "Assigned" is the count's column; the verb (assign, assigns, assigning) is the action a read-only page doesn't offer.
    for (const word of [/\bassign(?!ed)/i, /release/i, /revoke/i, /refund/i, /checkout/i, /\bpay/i, /cancel/i, /upgrade/i, /renew/i, /\bbuy\b/i, /purchase/i]) {
      expect([word.source, word.test(text)]).toEqual([word.source, false]);
    }
  });
});

describe("the Licenses page's requests", () => {
  test("licensesPath carries the search and the cursor, URL-encoded, and nothing when empty", () => {
    expect(licensesPath("", undefined)).toBe("/api/admin/licenses");
    expect(licensesPath("  ", undefined)).toBe("/api/admin/licenses");
    expect(licensesPath("Acme & Sons", undefined)).toBe("/api/admin/licenses?query=Acme+%26+Sons");
    expect(licensesPath("", "lic_01")).toBe("/api/admin/licenses?cursor=lic_01");
    expect(licensesPath(" acme ", "lic:01")).toBe("/api/admin/licenses?query=acme&cursor=lic%3A01");
  });

  test("the list asks Core for its first page, then for the page after the cursor, with the search text, and only reads", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json({ items: [], next: null });
    }) as typeof fetch;
    const { client } = mount([{ items: [workspaceLicense], next: "lic_workspace" }], { query: "ada" });
    try {
      const options = client.getQueryCache().find({ queryKey: [...LICENSES_QUERY_KEY, "ada"] })!.options as unknown as {
        queryFn: (context: { pageParam: string | undefined }) => Promise<unknown>;
        getNextPageParam: (lastPage: Served) => string | undefined;
        initialPageParam: string | undefined;
      };

      await options.queryFn({ pageParam: options.initialPageParam });
      await options.queryFn({ pageParam: options.getNextPageParam({ items: [workspaceLicense], next: "lic_workspace" }) });

      expect(options.getNextPageParam({ items: [workspaceLicense], next: null })).toBeUndefined();
      expect(calls).toEqual([
        { url: "/api/admin/licenses?query=ada", method: "GET" },
        { url: "/api/admin/licenses?query=ada&cursor=lic_workspace", method: "GET" },
      ]);
    } finally {
      globalThis.fetch = original;
      client.clear();
    }
  });

  test("each search is its own cached list", () => {
    const { client } = mount([{ items: [workspaceLicense], next: null }], { query: "" });
    try {
      expect(client.getQueryData([...LICENSES_QUERY_KEY, ""])).toBeDefined();
      expect(client.getQueryData([...LICENSES_QUERY_KEY, "ada"])).toBeUndefined();
    } finally {
      client.clear();
    }
  });
});

describe("the Licenses item in the admin portal's navigation", () => {
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

  const orgAdmin = (licenses?: { available: boolean }): AdminMe => ({
    authenticated: true,
    user: { mentraUserId: "mu_ada", email: "ada@acme.test", emailVerified: true, isOrganizationAdmin: true },
    credential: null,
    organization: { capabilities: [...ORGANIZATION_CAPABILITIES] },
    workspaces: [],
    ...(licenses ? { licenses } : {}),
  });

  test("is offered, labelled Licenses and right after Workspaces, once licenses are available", async () => {
    const { visibleNav } = await loadNav();
    const nav = visibleNav(visiblePages(orgAdmin({ available: true })));
    expect(nav.map(item => item.key)).toEqual(["incidents", "test-runs", "routine-catalog", "system-health", "workspaces", "licenses", "operator-keys", "audit"]);
    expect(nav.find(item => item.key === "licenses")?.label).toBe("Licenses");
  });

  test("is hidden on a Core with no billing and no licenses, or when the answer is missing", async () => {
    const { visibleNav } = await loadNav();
    expect(visibleNav(visiblePages(orgAdmin({ available: false }))).map(item => item.key)).not.toContain("licenses");
    expect(visibleNav(visiblePages(orgAdmin())).map(item => item.key)).not.toContain("licenses");
  });
});

describe("the admin portal says nothing about seats", () => {
  // The portal's pages, their titles and descriptions: every string, template and piece of JSX text in its source,
  // whether or not a screen draws it today. API and code names (`seatsUsed`) are identifiers, not words.
  const SRC = join(import.meta.dir, "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "assets" ? [] : sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const sentences = (file: string): Array<{ line: number; text: string }> => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: Array<{ line: number; text: string }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      const isText =
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
      if (isText && !ts.isLiteralTypeNode(node.parent)) found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText().trim() });
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  test("no sentence in the portal's source has the word, and the Licenses page's description counts licenses assigned", () => {
    const files = sources(SRC);
    expect(files.map(file => relative(SRC, file))).toEqual(expect.arrayContaining(["App.tsx", "pages/licenses.tsx"]));
    const all = files.flatMap(file => sentences(file).map(entry => ({ file: relative(SRC, file), ...entry })));
    expect(all.length).toBeGreaterThan(300);
    expect(all.filter(entry => /\bseats?\b/i.test(entry.text)).map(entry => `${entry.file}:${entry.line} ${entry.text}`)).toEqual([]);
    expect(all.some(entry => entry.file === "App.tsx" && entry.text.includes("how many licenses are assigned"))).toBe(true);
  });
});
