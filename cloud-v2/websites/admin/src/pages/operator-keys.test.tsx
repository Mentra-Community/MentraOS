import { describe, expect, spyOn, test } from "bun:test";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPERATOR_KEY_SCOPES, type CredentialView } from "@mentra/workspace-contract";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createKeyMutationOptions,
  createOperatorKeyAndReveal,
  OPERATOR_KEYS_QUERY_KEY,
  OperatorKeysScreen,
  parseCreateKeyForm,
  SCOPE_LABELS,
  scopeLabel,
} from "./operator-keys";

// A synthetic token shaped like a real one, so a leak would be recognizable.
const TOKEN = "mak_prod_01JZ0SYNTHETIC00000000000A.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

const harness: CredentialView = {
  credentialId: "cred_harness",
  prefix: "mak",
  name: "Routine harness",
  display: "mak_prod_…wxyz",
  workspaceId: null,
  scopes: ["organization.testing.read", "organization.testing.manage"],
  packageNames: [],
  createdByEmail: "sam@acme.test",
  issuedByService: null,
  expiresAt: "2027-01-31T23:59:59.000Z",
  lastUsedAt: null,
  createdAt: "2026-09-01T10:00:00.000Z",
};
const triage: CredentialView = {
  ...harness,
  credentialId: "cred_triage",
  name: "Triage bot",
  display: "mak_prod_…abcd",
  scopes: ["organization.incidents.read", "organization.supportProfiles.read"],
  expiresAt: null,
  lastUsedAt: "2026-09-20T08:00:00.000Z",
};

/** `list` null leaves the list query unseeded: still loading. */
function render(props: Parameters<typeof OperatorKeysScreen>[0] = {}, list: CredentialView[] | null = [harness, triage]): string {
  const client = new QueryClient();
  if (list) client.setQueryData(OPERATOR_KEYS_QUERY_KEY, { items: list });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OperatorKeysScreen {...props} />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

describe("operator keys page", () => {
  test("labels each scope in words", () => {
    expect(SCOPE_LABELS).toEqual({
      "organization.incidents.read": "Read incident reports",
      "organization.supportProfiles.read": "Look up support profiles",
      "organization.testing.read": "View test runs",
      "organization.testing.manage": "Manage test runs",
    });
    // Every scope a key may carry has a label.
    for (const scope of OPERATOR_KEY_SCOPES) expect(SCOPE_LABELS[scope]).toBeTruthy();
    // A scope this page does not know yet is shown as it is, not hidden.
    expect(scopeLabel("organization.future.read")).toBe("organization.future.read");
  });

  test("the create form offers one checkbox per operator scope, and no other", () => {
    const markup = render();
    const checkboxes = [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map(match => match[0]);
    expect(checkboxes).toHaveLength(OPERATOR_KEY_SCOPES.length);
    for (const scope of OPERATOR_KEY_SCOPES) {
      expect(markup).toContain(`value="${scope}"`);
      expect(markup).toContain(SCOPE_LABELS[scope]!);
    }
    expect(markup).not.toContain("organization.workspaces.administer");
    expect(markup).not.toContain("organization.credentials.manage");
    expect(markup).toContain("Expires (optional)");
    expect(markup).toContain("Create operator key");
  });

  test("lists keys by their display form with their scopes as labels", () => {
    const markup = render();
    expect(markup).toContain("Routine harness");
    expect(markup).toContain("mak_prod_…wxyz");
    expect(markup).toContain("Triage bot");
    expect(markup).toContain("Created by sam@acme.test");
    expect(markup).toContain("Never used");
    // The labels appear in the list as well as in the form.
    expect(markup.match(/View test runs/g)!.length).toBeGreaterThanOrEqual(2);
    expect(markup.match(/Look up support profiles/g)!.length).toBeGreaterThanOrEqual(2);
  });

  test("offers revoking each key behind a confirm step", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Revoke Routine harness"');
    expect(markup).toContain('aria-label="Revoke Triage bot"');
    // Only the first click of the confirm step is rendered.
    expect(markup).not.toContain("Confirm revoke");
  });

  test("an empty list says so and still offers the form", () => {
    const markup = render({}, []);
    expect(markup).toContain("No operator keys yet.");
    expect(markup).toContain("Create operator key");
  });

  test("a list still loading says so", () => {
    expect(render({}, null)).toContain("Loading");
  });

  test("never renders a token on the list", () => {
    expect(render()).not.toContain("mak_prod_01");
    expect(render()).not.toContain(TOKEN);
  });

  test("shows the token once, in a dialog, with a copy button", () => {
    const markup = render({ initialSecret: { status: "shown", name: "Routine harness", token: TOKEN } });
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("shown only once");
    expect(markup.split(TOKEN)).toHaveLength(2);
    expect(markup).toContain("Copy credential");
    expect(markup).toContain("Done");
  });

  test("once dismissed the token is nowhere in the page", () => {
    const markup = render({ initialSecret: { status: "hidden" } });
    expect(markup).not.toContain(TOKEN);
    expect(markup).not.toContain('role="dialog"');
  });
});

describe("creating an operator key", () => {
  test("a name and at least one scope are required", () => {
    expect(parseCreateKeyForm({ name: "  ", scopes: ["organization.testing.read"], expires: "" })).toEqual({
      ok: false,
      message: "Enter a name for the key.",
    });
    expect(parseCreateKeyForm({ name: "CI", scopes: [], expires: "" })).toEqual({
      ok: false,
      message: "Choose at least one scope.",
    });
  });

  test("builds the request: trimmed name, scopes in a stable order, no expiry unless chosen", () => {
    expect(
      parseCreateKeyForm({
        name: "  CI  ",
        scopes: ["organization.testing.manage", "organization.incidents.read", "organization.testing.manage"],
        expires: "",
      }),
    ).toEqual({
      ok: true,
      input: { name: "CI", scopes: ["organization.incidents.read", "organization.testing.manage"] },
    });
  });

  test("an expiry date becomes the end of that local day, and an unusable one is refused", () => {
    const ok = parseCreateKeyForm({ name: "CI", scopes: ["organization.testing.read"], expires: "2027-03-04" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const expiry = new Date(ok.input.expiresAt!);
      expect([expiry.getFullYear(), expiry.getMonth(), expiry.getDate(), expiry.getHours()]).toEqual([2027, 2, 4, 23]);
    }
    expect(parseCreateKeyForm({ name: "CI", scopes: ["organization.testing.read"], expires: "2027-02-31" })).toEqual({
      ok: false,
      message: "Choose a valid expiry date.",
    });
  });

  test("posts to the organization route and hands the token over once, returning only the key's listing view", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ credential: harness, token: TOKEN }, { status: 201 }));
    const revealed: Array<{ name: string; token: string }> = [];
    try {
      const result = await createOperatorKeyAndReveal(
        { name: "Routine harness", scopes: ["organization.testing.read"] },
        secret => revealed.push(secret),
      );
      expect(result).toEqual(harness);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(revealed).toEqual([{ name: "Routine harness", token: TOKEN }]);
      const [url, init] = spy.mock.calls[0]!;
      expect(url).toBe("/api/organization/credentials");
      expect(init).toMatchObject({ method: "POST" });
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        name: "Routine harness",
        scopes: ["organization.testing.read"],
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("the token is in neither the mutation cache nor the query cache", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ credential: harness, token: TOKEN }, { status: 201 }));
    const client = new QueryClient();
    const revealed: string[] = [];
    try {
      const observer = new MutationObserver(client, createKeyMutationOptions(client, secret => revealed.push(secret.token)));
      const result = await observer.mutate({ name: "Routine harness", scopes: ["organization.testing.read"] });
      expect(result).toEqual(harness);
      expect(revealed).toEqual([TOKEN]);
      const held = JSON.stringify([
        client.getMutationCache().getAll().map(mutation => mutation.state),
        client.getQueryCache().getAll().map(query => query.state),
      ]);
      expect(held).not.toContain(TOKEN);
    } finally {
      spy.mockRestore();
      client.clear();
    }
  });
});
