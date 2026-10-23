import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchPortalMe, fetchPublicProductName } from "./api";

const BASE = {
  authenticated: true,
  user: { id: "mu_ada", email: "ada@acme.test", emailVerified: true },
  workspaceCreation: { allowed: true, reason: null },
  onboardingRequired: false,
  org: null,
};

describe("who the portal says is signed in", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  /** `fetchPortalMe` against a Core that answers `body`; resolves with the request it saw too. */
  async function meFor(body: unknown) {
    const requests: string[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json(body);
    }) as unknown as typeof fetch);
    restore = () => spy.mockRestore();
    return { me: await fetchPortalMe(), requests };
  }

  test("reads /api/portal/me, and offers a module only when Core says true", async () => {
    const { me, requests } = await meFor({ ...BASE, modules: { billing: true, billingCatalog: true } });
    expect(requests).toEqual(["/api/portal/me"]);
    expect(me.modules).toEqual({ billing: true, billingCatalog: true });
    expect(me.user).toEqual(BASE.user);
    expect((await meFor({ ...BASE, modules: { billing: false, billingCatalog: false } })).me.modules).toEqual({
      billing: false,
      billingCatalog: false,
    });
  });

  test("the catalog is offered on its own: a non-staff Admin on staging sees licenses without billing", async () => {
    const { me } = await meFor({ ...BASE, modules: { billing: false, billingCatalog: true } });
    expect(me.modules).toEqual({ billing: false, billingCatalog: true });
  });

  test("an older Core that sends no billingCatalog is read as billing: what it offered then is what it offers now", async () => {
    expect((await meFor({ ...BASE, modules: { billing: true } })).me.modules).toEqual({ billing: true, billingCatalog: true });
    expect((await meFor({ ...BASE, modules: { billing: false } })).me.modules).toEqual({ billing: false, billingCatalog: false });
  });

  test("billing implies the catalog: a contradictory /me is read the way decision 4 has it", async () => {
    // Billing ready and visible to them means the catalog is ready, whatever billingCatalog says.
    for (const billingCatalog of [false, "yes", 1, null, "true"]) {
      expect((await meFor({ ...BASE, modules: { billing: true, billingCatalog } })).me.modules).toEqual({ billing: true, billingCatalog: true });
    }
  });

  test("a Core that sends no modules, or something other than true, offers none", async () => {
    const none = { billing: false, billingCatalog: false };
    for (const modules of [undefined, null, {}, { billing: "yes" }, { billing: 1 }, { billing: null }]) {
      expect((await meFor({ ...BASE, modules })).me.modules).toEqual(none);
    }
    // A billingCatalog that is there but isn't true offers nothing of its own.
    for (const billingCatalog of ["yes", 1, null, "true", false]) {
      expect((await meFor({ ...BASE, modules: { billing: false, billingCatalog } })).me.modules).toEqual(none);
    }
  });
});

describe("the public name of a product, for a page with no session", () => {
  const answering = (response: () => Response | Promise<Response>) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return response();
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  test("reads GET /api/portal/billing/public/products/<product>, with the product's key encoded, and returns its name", async () => {
    const { calls, fetchImpl } = answering(() => Response.json({ name: "Mentra Call Unlimited" }));
    expect(await fetchPublicProductName("mentra.call.unlimited", fetchImpl)).toBe("Mentra Call Unlimited");
    expect(calls.map(call => call.url)).toEqual(["/api/portal/billing/public/products/mentra.call.unlimited"]);
    expect(calls[0]!.init?.method).toBeUndefined();
    await fetchPublicProductName("a/b c", fetchImpl);
    expect(calls[1]!.url).toBe("/api/portal/billing/public/products/a%2Fb%20c");
  });

  test("an unknown product, any other refusal, a body that isn't {name}, and a dropped connection are all null", async () => {
    for (const response of [
      () => Response.json({ error: "not_found" }, { status: 404 }),
      () => Response.json({}, { status: 500 }),
      () => Response.json({ name: 7 }),
      () => Response.json({ name: "   " }),
      () => Response.json(null),
      () => new Response("<html>bad gateway</html>"),
      () => {
        throw new Error("offline");
      },
    ]) {
      expect(await fetchPublicProductName("mentra.call.unlimited", answering(response).fetchImpl)).toBeNull();
    }
  });
});
