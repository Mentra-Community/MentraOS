/** Revoking an operator key asks in a dialog: it opens with the question, Cancel sends nothing, and Revoke sends the request. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CredentialView } from "@mentra/workspace-contract";
import { byText, cleanup, click, find, findAll, render, setupDom, teardownDom, until } from "@mentra/workspace-ui/test-dom";
import { OperatorKeysPage } from "./operator-keys";

const key = (credentialId: string, name: string): CredentialView => ({
  credentialId,
  prefix: "mak",
  name,
  display: `mak_prod_…${credentialId.slice(-4)}`,
  workspaceId: null,
  scopes: ["organization.testing.read"],
  packageNames: [],
  createdByEmail: "sam@acme.test",
  issuedByService: null,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: "2026-09-01T10:00:00.000Z",
});

const realFetch = globalThis.fetch;
const calls: Array<{ method: string; path: string }> = [];
let keys: CredentialView[] = [];
let refuse = false;

const reply = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "", json: async () => structuredClone(body) }) as unknown as Response;

beforeAll(async () => {
  await setupDom();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({ method, path });
    if (method === "DELETE") {
      if (refuse) return reply(403, { error: "forbidden", error_description: "Only an Organization Admin can revoke keys." });
      keys = keys.filter((other) => path.endsWith(`/${other.credentialId}`) === false);
      return reply(204);
    }
    return reply(200, { items: keys });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await teardownDom();
});
afterEach(async () => {
  await cleanup();
  calls.length = 0;
  refuse = false;
});

const writes = () => calls.filter((call) => call.method !== "GET");
const openDialogs = () => findAll<HTMLDialogElement>("dialog").filter((dialog) => dialog.open);
const revokeButton = (name: string) => find<HTMLButtonElement>(`button[aria-label="Revoke ${name}"]`);

async function mount() {
  keys = [key("cred_harness", "Routine harness"), key("cred_triage", "Triage bot")];
  await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OperatorKeysPage />
    </QueryClientProvider>,
  );
  await until(() => findAll('button[aria-label^="Revoke "]').length === 2, "the keys to load");
}

describe("revoking an operator key", () => {
  test("asks in a dialog, Cancel sends nothing, Revoke sends the request and focus moves to the next key", async () => {
    await mount();
    expect(findAll('[role="group"]')).toHaveLength(0);
    await click(revokeButton("Routine harness"));
    const [dialog] = openDialogs();
    expect(find("h2", dialog!).textContent).toBe("Revoke Routine harness?");
    expect(dialog!.textContent).toContain("Anything using it stops working.");
    expect(writes()).toHaveLength(0);

    await click(byText("Cancel", "button", dialog!));
    expect(openDialogs()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(document.activeElement).toBe(revokeButton("Routine harness"));

    await click(revokeButton("Routine harness"));
    await click(byText("Revoke", "button", openDialogs()[0]!));
    await until(() => openDialogs().length === 0 && findAll('button[aria-label="Revoke Routine harness"]').length === 0, "the key to go");
    expect(writes()).toEqual([{ method: "DELETE", path: "/api/admin/organization/credentials/cred_harness" }]);
    expect(document.activeElement).toBe(revokeButton("Triage bot"));
  });

  test("a refusal is shown in the dialog, which stays open", async () => {
    await mount();
    refuse = true;
    await click(revokeButton("Triage bot"));
    await click(byText("Revoke", "button", openDialogs()[0]!));
    await until(() => findAll('[role="alert"]', openDialogs()[0]!).length === 1, "the refusal");
    expect(find('[role="alert"]', openDialogs()[0]!).textContent).toBe("Only an Organization Admin can revoke keys.");
    expect(document.activeElement).toBe(byText("Revoke", "button", openDialogs()[0]!));
  });
});
