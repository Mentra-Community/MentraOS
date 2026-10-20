import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchPortalMe } from "./api";

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
    const { me, requests } = await meFor({ ...BASE, modules: { billing: true } });
    expect(requests).toEqual(["/api/portal/me"]);
    expect(me.modules).toEqual({ billing: true });
    expect(me.user).toEqual(BASE.user);
    expect((await meFor({ ...BASE, modules: { billing: false } })).me.modules).toEqual({ billing: false });
  });

  test("a Core that sends no modules, or something other than true, offers none", async () => {
    for (const modules of [undefined, null, {}, { billing: "yes" }, { billing: 1 }, { billing: null }]) {
      expect((await meFor({ ...BASE, modules })).me.modules).toEqual({ billing: false });
    }
  });
});
