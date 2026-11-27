/** Ending a workspace's grant early, from the open workspace's Licenses tab: who is offered it, what it asks, sends and says. */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminLicenseView, LicenseGrantEnded } from "@mentra/workspace-contract";
import { byText, cleanup, click, find, findAll, render, setupDom, teardownDom, until } from "@mentra/workspace-ui/test-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../lib/api";
import { LICENSES_QUERY_KEY } from "./licenses";
import {
  canEndGrant,
  EndGrantDialog,
  endGrantConsequence,
  endGrantRefusalMessage,
  endLicenseGrant,
  grantEndedMessage,
  WorkspaceLicensesWithEnding,
} from "./workspace-license-end";

// Synthetic data only.
const NOW = Date.parse("2026-11-26T12:00:00Z");
const acme = { workspaceId: "ws_acme", name: "Acme Robotics" };
const granted: AdminLicenseView = {
  licenseId: "lic_granted",
  owner: { type: "workspace", workspaceId: "ws_acme", name: "Acme Robotics" },
  product: "mentra.call.unlimited",
  quantity: 5,
  seatsUsed: 3,
  validFrom: "2026-01-01T00:00:00.000Z",
  paidThrough: "2099-01-31T00:00:00.000Z",
  endedAt: null,
  endedReason: null,
};
const expired: AdminLicenseView = { ...granted, licenseId: "lic_expired", paidThrough: "2020-03-15T00:00:00.000Z" };
const lapsed: AdminLicenseView = { ...granted, licenseId: "lic_lapsed", endedAt: "2026-09-01T00:00:00.000Z", endedReason: "lapsed" };
const ended: LicenseGrantEnded = {
  workspaceId: "ws_acme",
  product: "mentra.call.unlimited",
  subscriptionId: "sub_1",
  licenseId: "lic_granted",
  endedAt: "2026-11-26T12:00:00Z",
};

/** The tab, rendered on the server with the workspace's licenses already in the cache. */
function tab(canEndGrants: boolean, items: AdminLicenseView[] = [granted, expired, lapsed]): string {
  const client = new QueryClient();
  client.setQueryData([...LICENSES_QUERY_KEY, "ws_acme"], { pages: [{ items, next: null }], pageParams: [undefined] });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WorkspaceLicensesWithEnding workspace={acme} canEndGrants={canEndGrants} />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

describe("End grant on a workspace's Licenses tab", () => {
  test("is offered on an active license alone, and only to a caller who may grant", () => {
    const offered = tab(true);
    expect(offered.match(/>End grant<\/button>/g)).toHaveLength(1);
    expect(offered).toContain('aria-label="End the grant of Mentra Call Unlimited"');
    expect(offered).toContain(">Actions</span>");
    // The row it is on is the active one: the expired and the ended rows come after it, with no button.
    expect(offered.indexOf("lic_granted")).toBeLessThan(offered.indexOf("End grant"));
    expect(offered.indexOf("End grant")).toBeLessThan(offered.indexOf("lic_expired"));
    const readOnly = tab(false);
    expect(readOnly).toContain("lic_granted");
    expect(readOnly).not.toContain("End grant");
    expect(readOnly).not.toContain("<button");
    expect(readOnly).not.toContain("Actions");
  });

  test("canEndGrant: a license in its term that has not ended", () => {
    expect(canEndGrant(granted, NOW)).toBe(true);
    expect(canEndGrant(expired, NOW)).toBe(false);
    expect(canEndGrant(lapsed, NOW)).toBe(false);
    expect(canEndGrant({ ...granted, validFrom: "2098-01-01T00:00:00.000Z" }, NOW)).toBe(false);
  });

  test("the dialog names the workspace and the product, says who loses it, and takes an optional note", () => {
    const client = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <EndGrantDialog workspace={acme} license={granted} onClose={() => {}} onEnded={() => {}} />
      </QueryClientProvider>,
    );
    expect(markup).toContain("End this grant?");
    expect(markup).toContain("<strong>Acme Robotics</strong>");
    expect(markup).toContain("<strong>Mentra Call Unlimited</strong>");
    expect(markup).toContain("The 3 people it is assigned to lose Mentra Call Unlimited");
    expect(markup).toContain("Nothing is refunded");
    expect(markup).toContain("Note (optional)");
    expect(markup).toContain('maxLength="500"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>End grant<\/button>/);
    expect(markup).not.toContain('role="alert"');
  });

  test("says who loses the product, from the licenses assigned", () => {
    expect(endGrantConsequence(granted)).toBe(
      "The 3 people it is assigned to lose Mentra Call Unlimited: their licenses are unassigned at once, and it stops working for them within the hour.",
    );
    expect(endGrantConsequence({ ...granted, seatsUsed: 1 })).toContain("The 1 person it is assigned to loses Mentra Call Unlimited");
    expect(endGrantConsequence({ ...granted, seatsUsed: 0 })).toBe("None of its 5 licenses are assigned, so nobody loses Mentra Call Unlimited.");
    expect(endGrantConsequence({ product: "mentra.other", quantity: 1, seatsUsed: 0 })).toBe("Its license isn't assigned to anyone, so nobody loses mentra.other.");
  });
});

describe("ending a grant", () => {
  test("posts to Core's route for the workspace and the product, with the note only when there is one", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json(ended);
    }) as unknown as typeof fetch);
    try {
      expect(await endLicenseGrant("ws/acme", "mentra.call.unlimited", "  Sold through another reseller ")).toEqual(ended);
      expect(seen[0]!.url).toBe("/api/admin/organization/workspaces/ws%2Facme/license-grants/mentra.call.unlimited/end");
      expect(seen[0]!.init.method).toBe("POST");
      expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ note: "Sold through another reseller" });
      await endLicenseGrant("ws_acme", "mentra.call.unlimited", "   ");
      expect(seen[1]!.url).toBe("/api/admin/organization/workspaces/ws_acme/license-grants/mentra.call.unlimited/end");
      expect(seen[1]!.init.method).toBe("POST");
      expect(seen[1]!.init.body).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("says what ended and what became of the people who had it", () => {
    expect(grantEndedMessage("Acme Robotics", ended)).toBe(
      "Acme Robotics's grant of Mentra Call Unlimited has ended. Its licenses are unassigned, and Mentra Call Unlimited stops working for the people who had it within the hour. To give it back, grant it again.",
    );
  });

  test("puts each refusal in the admin's words", () => {
    const refused = (code: string, status = 409) => endGrantRefusalMessage(new ApiError("as Core said it", status, code), "mentra.call.unlimited");
    expect(refused("not_a_grant")).toBe(
      "This workspace bought Mentra Call Unlimited; it wasn't granted, so it can't be ended here. Its admins cancel it on the workspace's own Licenses page.",
    );
    expect(refused("grant_renewed")).toBe(
      "This workspace renewed this grant, so Mentra Call Unlimited is now its own subscription and can't be ended here. Its admins cancel it on the workspace's own Licenses page.",
    );
    expect(refused("grant_not_found", 404)).toBe("This workspace has no grant of Mentra Call Unlimited running. It may have ended already: refresh the list.");
    expect(refused("billing_unavailable", 503)).toContain("may or may not have ended");
    expect(refused("checkout_in_progress")).toContain("Try again in a minute");
    expect(refused("reset_in_progress")).toContain("being reset");
    expect(refused("workspace_not_found", 404)).toBe("This workspace no longer exists.");
    expect(refused("something_new")).toBe("as Core said it");
    expect(endGrantRefusalMessage(new Error("Request timed out. Please try again."), "mentra.call.unlimited")).toBe("Request timed out. Please try again.");
  });
});

describe("the dialog, opened from the tab", () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ method: string; path: string; body: string | null }> = [];
  let licenses: AdminLicenseView[] = [];
  let refusal: { status: number; body: unknown } | null = null;

  const reply = (status: number, body?: unknown) =>
    ({ ok: status >= 200 && status < 300, status, statusText: "", json: async () => structuredClone(body) }) as unknown as Response;

  beforeAll(async () => {
    await setupDom();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, path: String(input), body: typeof init?.body === "string" ? init.body : null });
      if (method === "POST") {
        if (refusal) return reply(refusal.status, refusal.body);
        // The license ends in Core with the grant, as billing's write makes it.
        licenses = licenses.map(license => ({ ...license, seatsUsed: 0, endedAt: ended.endedAt, endedReason: "lapsed" as const }));
        return reply(200, ended);
      }
      return reply(200, { items: licenses, next: null });
    }) as typeof fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await teardownDom();
  });
  afterEach(async () => {
    await cleanup();
    calls.length = 0;
    refusal = null;
  });

  const writes = () => calls.filter(call => call.method !== "GET");
  const openDialogs = () => findAll<HTMLDialogElement>("dialog").filter(dialog => dialog.open);
  const endButtons = () => findAll<HTMLButtonElement>('button[aria-label^="End the grant of "]');

  async function mount() {
    licenses = [granted];
    await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WorkspaceLicensesWithEnding workspace={acme} canEndGrants />
      </QueryClientProvider>,
    );
    await until(() => endButtons().length === 1, "the license to load");
  }

  test("Cancel sends nothing; End grant sends the request, says it ended and reads the list again", async () => {
    await mount();
    await click(endButtons()[0]!);
    const [dialog] = openDialogs();
    expect(find("h2", dialog!).textContent).toBe("End this grant?");
    expect(dialog!.textContent).toContain("Acme Robotics's grant of Mentra Call Unlimited");
    await click(byText("Cancel", "button", dialog!));
    expect(openDialogs()).toHaveLength(0);
    expect(writes()).toHaveLength(0);

    await click(endButtons()[0]!);
    await click(byText("End grant", "button", openDialogs()[0]!));
    await until(() => openDialogs().length === 0 && findAll('[role="status"]').some(note => note.textContent?.includes("has ended")), "the grant to end");
    expect(writes()).toEqual([{ method: "POST", path: "/api/admin/organization/workspaces/ws_acme/license-grants/mentra.call.unlimited/end", body: null }]);
    // The list is read again, and the license it shows has ended: there is nothing left to end.
    await until(() => endButtons().length === 0, "the list to be read again");
    expect(document.body.textContent).toContain("Ended: subscription ended");
    expect(calls.filter(call => call.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  test("a refusal is shown in the dialog, which stays open, and nothing is said to have ended", async () => {
    await mount();
    refusal = { status: 409, body: { error: "not_a_grant", error_description: "the workspace's license of this product is not a grant" } };
    await click(endButtons()[0]!);
    await click(byText("End grant", "button", openDialogs()[0]!));
    await until(() => findAll('[role="alert"]', openDialogs()[0]!).length === 1, "the refusal");
    expect(find('[role="alert"]', openDialogs()[0]!).textContent).toContain("This workspace bought Mentra Call Unlimited; it wasn't granted");
    expect(findAll('[role="status"]').some(note => note.textContent?.includes("has ended"))).toBe(false);
    expect(endButtons()).toHaveLength(1);
  });
});
