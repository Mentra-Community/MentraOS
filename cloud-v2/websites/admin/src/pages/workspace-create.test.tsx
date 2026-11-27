import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateWorkspaceDialog, createdWorkspaceMessage, createWorkspaceForInvitedOwner, parseNewWorkspace } from "./workspace-create";

// Synthetic data only.
const created = { workspaceId: "ws_new", name: "Northwind", status: "active", authorizationRevision: 0, owner: null };

/** Every request the code under test sent, with fetch answering each in turn. */
function answering(...replies: Response[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return replies.shift() ?? Response.json({ error: "unexpected" }, { status: 500 });
  }) as unknown as typeof fetch);
  return { calls, restore: () => spy.mockRestore() };
}

describe("a new workspace's form", () => {
  test("needs a name and the owner's email, trimmed", () => {
    expect(parseNewWorkspace("", "sam@northwind.test")).toEqual({ ok: false, message: "Enter the workspace's name." });
    expect(parseNewWorkspace("x".repeat(81), "sam@northwind.test")).toEqual({ ok: false, message: "A workspace's name is at most 80 characters." });
    for (const email of ["", "sam", "sam@northwind", "sam @northwind.test"]) {
      expect(parseNewWorkspace("Northwind", email)).toEqual({ ok: false, message: "Enter the owner's email address." });
    }
    expect(parseNewWorkspace("  Northwind ", " sam@northwind.test ")).toEqual({ ok: true, name: "Northwind", email: "sam@northwind.test" });
    // Longer than Core invites: refused before a workspace is made for it.
    const long = `${"s".repeat(243)}@northwind.test`;
    expect(long.length).toBe(258);
    expect(parseNewWorkspace("Northwind", long)).toEqual({ ok: false, message: "An email address is at most 254 characters." });
    expect(parseNewWorkspace("Northwind", `${"s".repeat(239)}@northwind.test`).ok).toBe(true);
  });

  test("asks for both, and says the owner needs no account", () => {
    const client = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CreateWorkspaceDialog onClose={() => {}} onCreated={() => {}} />
      </QueryClientProvider>,
    );
    expect(markup).toContain("New workspace");
    expect(markup).toContain("Workspace name");
    expect(markup).toContain("Owner&#x27;s email");
    expect(markup).toContain("They don&#x27;t need a Mentra account yet");
    expect(markup).toContain("Create and invite");
  });
});

describe("making a workspace for an invited owner", () => {
  test("creates it with no owner, then invites the person as its Owner", async () => {
    const fetched = answering(Response.json(created, { status: 201 }), Response.json({ invitationId: "wi_1" }, { status: 201 }));
    try {
      const result = await createWorkspaceForInvitedOwner({ name: "Northwind", email: "sam@northwind.test" });
      expect(result).toEqual({ workspaceId: "ws_new", name: "Northwind", email: "sam@northwind.test", invitationProblem: null });
      expect(fetched.calls).toEqual([
        { url: "/api/admin/organization/workspaces", method: "POST", body: { name: "Northwind" } },
        { url: "/api/admin/workspaces/ws_new/invitations", method: "POST", body: { email: "sam@northwind.test", role: "owner" } },
      ]);
      expect(createdWorkspaceMessage(result)).toContain("sam@northwind.test was invited as its owner");
    } finally {
      fetched.restore();
    }
  });

  test("a workspace whose invitation failed is reported as made, with what is left to do", async () => {
    const fetched = answering(
      Response.json(created, { status: 201 }),
      Response.json({ error: "rate_limited", error_description: "Too many invitations. Try again later." }, { status: 429 }),
    );
    try {
      const result = await createWorkspaceForInvitedOwner({ name: "Northwind", email: "sam@northwind.test" });
      expect(result.workspaceId).toBe("ws_new");
      expect(result.invitationProblem).toBe("Too many invitations. Try again later.");
      expect(createdWorkspaceMessage(result)).toBe(
        "Northwind was created, but the invitation to sam@northwind.test was not sent: Too many invitations. Try again later. Open the workspace and invite its owner from Invitations.",
      );
    } finally {
      fetched.restore();
    }
  });

  test("a workspace Core refuses to make invites nobody", async () => {
    const fetched = answering(Response.json({ error: "forbidden", error_description: "not allowed" }, { status: 403 }));
    try {
      await expect(createWorkspaceForInvitedOwner({ name: "Northwind", email: "sam@northwind.test" })).rejects.toThrow("not allowed");
      expect(fetched.calls).toHaveLength(1);
    } finally {
      fetched.restore();
    }
  });
});
