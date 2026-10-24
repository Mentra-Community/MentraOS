/**
 * The Miniapp registry page's questions: Archive asks first, says how many entries the rule covers and sends nothing
 * until the person confirms; Unarchive asks in a dialog; Register URLs sends the list and shows what each URL came to.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminRegistryEntryView, AdminRegistryRuleView } from "@mentra/workspace-contract";
import { byText, cleanup, click, find, findAll, render, setupDom, teardownDom, typeInto, until } from "@mentra/workspace-ui/test-dom";
import { RegistryPage } from "./registry";

const entry = (host: string, overrides: Partial<AdminRegistryEntryView> = {}): AdminRegistryEntryView => ({
  url: `https://${host}/`,
  packageName: `com.example.${host.split(".")[0]}`,
  registrableDomain: "example.com",
  name: host.split(".")[0]!.replace(/^./, letter => letter.toUpperCase()),
  version: "1.0.0",
  ageRating: null,
  iconUrl: null,
  verification: "verified",
  private: false,
  status: "active",
  archivedBy: [],
  firstRegisteredAt: "2026-10-01T12:00:00.000Z",
  firstRegisteredBy: "mu_alice",
  lastVerifiedAt: "2026-10-20T12:00:00.000Z",
  ...overrides,
});

const realFetch = globalThis.fetch;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let entries: AdminRegistryEntryView[] = [];
let rules: AdminRegistryRuleView[] = [];
let refuse: string | null = null;

const reply = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "", json: async () => structuredClone(body) }) as unknown as Response;

/** How many entries each rule covers, as Core would answer. */
function coverage(kind: string, value: string) {
  if (kind === "domain" && value.includes("notes.")) return reply(400, { error: "invalid_request", error_description: "not a valid domain archive rule" });
  const covered = entries.filter(row =>
    kind === "url" ? row.url === value : kind === "package" ? row.packageName === value : kind === "domain" ? row.registrableDomain === value : row.firstRegisteredBy === value,
  );
  return reply(200, {
    rule: { kind, value },
    entries: covered.length,
    activeEntries: covered.filter(row => row.status === "active").length,
    exists: rules.some(rule => rule.kind === kind && rule.value === value),
  });
}

beforeAll(async () => {
  await setupDom();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const url = new URL(path, "https://admin.test");
    if (url.pathname === "/api/admin/registry/entries") return reply(200, { items: entries, next: null });
    if (url.pathname === "/api/admin/registry/rules") return reply(200, { items: rules, next: null });
    if (url.pathname === "/api/admin/registry/coverage") return coverage(url.searchParams.get("kind")!, url.searchParams.get("value")!);
    if (refuse) return reply(403, { error: "forbidden", error_description: refuse });
    if (url.pathname === "/api/admin/registry/archive") {
      rules = [{ ...body.rule, reason: body.reason ?? "", createdBy: "admin@mentra.glass", createdAt: "2026-10-22T09:00:00.000Z" }, ...rules];
      return reply(200, { rule: body.rule, created: true, entriesArchived: 1 });
    }
    if (url.pathname === "/api/admin/registry/unarchive") {
      rules = rules.filter(rule => !(rule.kind === body.rule.kind && rule.value === body.rule.value));
      return reply(200, { rule: body.rule, removed: true, entriesRestored: 1 });
    }
    if (url.pathname === "/api/admin/registry/register") {
      return reply(200, {
        results: body.urls.map((input: string) =>
          input.includes("notes")
            ? { input, result: "accepted", url: input, packageName: "com.example.notes", name: "Notes" }
            : { input, result: "unreachable" },
        ),
      });
    }
    return reply(404, { error: "not_found" });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await teardownDom();
});
afterEach(async () => {
  await cleanup();
  calls.length = 0;
  refuse = null;
});

const writes = () => calls.filter(call => call.method !== "GET");
const reads = (pathname: string) => calls.filter(call => call.method === "GET" && call.path.startsWith(pathname));
const openDialogs = () => findAll<HTMLDialogElement>("dialog").filter(dialog => dialog.open);
const dialog = () => {
  const [open] = openDialogs();
  if (!open) throw new Error("no dialog is open");
  return open;
};

async function mount() {
  entries = [entry("notes.example.com"), entry("tasks.example.com", { status: "archived", archivedBy: ["package"] }), entry("timer.example.com")];
  rules = [{ kind: "package", value: "com.example.tasks", reason: "Copy of another miniapp", createdBy: "admin@mentra.glass", createdAt: "2026-10-21T09:00:00.000Z" }];
  await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RegistryPage />
    </QueryClientProvider>,
  );
  await until(() => findAll('button[aria-label^="Archive "]').length === 3 && findAll('button[aria-label^="Unarchive "]').length === 1, "the lists to load");
}

describe("archiving", () => {
  test("asks first, says how many entries each choice covers, and Cancel sends nothing", async () => {
    await mount();
    await click(find('button[aria-label="Archive Notes"]'));
    expect(find("h2", dialog()).textContent).toBe("Archive Notes?");
    const choices = findAll<HTMLInputElement>('input[type="radio"]', dialog());
    expect(choices.map(choice => choice.value)).toEqual(["url", "package", "domain", "account"]);
    expect(choices[0]!.checked).toBe(true);
    await until(() => dialog().textContent!.includes("This covers 1 entry."), "the URL's coverage");

    await click(choices[2]!);
    await until(() => dialog().textContent!.includes("This covers 3 entries, 2 of them active."), "the domain's coverage");
    expect(reads("/api/admin/registry/coverage").map(call => new URL(call.path, "https://admin.test").searchParams.toString())).toEqual([
      "kind=url&value=https%3A%2F%2Fnotes.example.com%2F",
      "kind=domain&value=example.com",
    ]);

    await click(byText("Cancel", "button", dialog()));
    expect(openDialogs()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(document.activeElement).toBe(find('button[aria-label="Archive Notes"]'));
  });

  test("Archive sends the chosen rule with its reason, closes, and the rule is listed", async () => {
    await mount();
    await click(find('button[aria-label="Archive Timer"]'));
    await click(findAll<HTMLInputElement>('input[type="radio"]', dialog())[3]!);
    await until(() => dialog().textContent!.includes("This covers 3 entries, 2 of them active."), "the account's coverage");
    await typeInto(find<HTMLInputElement>('input[placeholder="Shown with the rule"]', dialog()), "  Spam account  ");
    await click(byText("Archive", "button", dialog()));

    await until(() => openDialogs().length === 0, "the dialog to close");
    expect(writes()).toEqual([
      { method: "POST", path: "/api/admin/registry/archive", body: { rule: { kind: "account", value: "mu_alice" }, reason: "Spam account" } },
    ]);
    await until(() => findAll('button[aria-label="Unarchive everything account mu_alice registered"]').length === 1, "the new rule");
  });

  test("a refusal is shown in the dialog, which stays open", async () => {
    await mount();
    refuse = "organization.registry.administer is required";
    await click(find('button[aria-label="Archive Notes"]'));
    await until(() => dialog().textContent!.includes("This covers 1 entry."), "the coverage");
    await click(byText("Archive", "button", dialog()));
    await until(() => findAll('[role="alert"]', dialog()).length === 1, "the refusal");
    expect(find('[role="alert"]', dialog()).textContent).toBe("organization.registry.administer is required");
  });

  test("a rule by hand is counted too, and a value Core refuses says what it takes and can't be archived", async () => {
    await mount();
    const value = find<HTMLInputElement>('input[placeholder="example.com"]');
    await typeInto(value, "notes.example.com");
    await click(byText("Archive…", "button"));
    expect(find("h2", dialog()).textContent).toBe("Archive the domain notes.example.com?");
    expect(findAll('input[type="radio"]', dialog())).toHaveLength(0);
    await until(() => dialog().textContent!.includes("Enter a registrable domain"), "the refusal");
    expect(byText("Archive", "button", dialog()).hasAttribute("disabled")).toBe(true);
    await click(byText("Cancel", "button", dialog()));

    await typeInto(value, "spam.example.org");
    await click(byText("Archive…", "button"));
    await until(() => dialog().textContent!.includes("No entries match yet."), "the coverage");
    await click(byText("Archive", "button", dialog()));
    await until(() => openDialogs().length === 0, "the dialog to close");
    expect(writes()).toEqual([{ method: "POST", path: "/api/admin/registry/archive", body: { rule: { kind: "domain", value: "spam.example.org" } } }]);
  });
});

describe("unarchiving", () => {
  test("asks in a dialog; Cancel sends nothing and Unarchive removes the rule", async () => {
    await mount();
    const button = () => find('button[aria-label="Unarchive the package com.example.tasks"]');
    await click(button());
    expect(find("h2", dialog()).textContent).toBe("Unarchive the package com.example.tasks?");
    expect(dialog().textContent).toContain("Phones can install and update what it covers again, unless another rule covers it.");
    await click(byText("Cancel", "button", dialog()));
    expect(writes()).toHaveLength(0);

    await click(button());
    await click(byText("Unarchive", "button", dialog()));
    await until(() => openDialogs().length === 0 && findAll('button[aria-label^="Unarchive "]').length === 0, "the rule to go");
    expect(writes()).toEqual([{ method: "POST", path: "/api/admin/registry/unarchive", body: { rule: { kind: "package", value: "com.example.tasks" } } }]);
    expect(document.body.textContent).toContain("No archive rules.");
  });
});

describe("registering URLs", () => {
  test("sends the list and shows what each URL came to; an empty list sends nothing", async () => {
    await mount();
    await click(byText("Register URLs", "button"));
    expect(find("h2", dialog()).textContent).toBe("Register URLs");
    await click(byText("Register", "button", dialog()));
    expect(find('[role="alert"]', dialog()).textContent).toBe("Enter at least one miniapp URL.");
    expect(writes()).toHaveLength(0);

    const field = find<HTMLTextAreaElement>("textarea", dialog());
    await typeIntoTextarea(field, "https://notes.example.com/\n\nhttps://offline.example.com/\n");
    await click(byText("Register", "button", dialog()));
    await until(() => findAll('[aria-label="Results"] li', dialog()).length === 2, "the results");
    expect(writes()).toEqual([
      { method: "POST", path: "/api/admin/registry/register", body: { urls: ["https://notes.example.com/", "https://offline.example.com/"] } },
    ]);
    const results = findAll('[aria-label="Results"] li', dialog()).map(item => item.textContent);
    expect(results).toEqual(["https://notes.example.com/Registered as Notes.", "https://offline.example.com/Not added. Core couldn't reach it."]);

    await click(byText("Done", "button", dialog()));
    expect(openDialogs()).toHaveLength(0);
  });
});

/** Typing into a textarea the way a person does: the value changes, then `input` fires. */
async function typeIntoTextarea(field: HTMLTextAreaElement, text: string) {
  const { act } = await import("react");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
