import { ORGANIZATION_CAPABILITIES, type OrganizationCapability } from "@mentra/workspace-contract";
import { describe, expect, test } from "bun:test";
import { PAGE_ORDER, resolvePage, visiblePages, type AdminMe } from "./admin-access";

function me(capabilities: readonly OrganizationCapability[], isOrganizationAdmin = false): Pick<AdminMe, "organization" | "user"> {
  return {
    organization: { capabilities: [...capabilities] },
    user: { mentraUserId: "mu_1", email: "a@example.test", emailVerified: true, isOrganizationAdmin },
  };
}

describe("the admin portal's pages follow capabilities", () => {
  test("an Organization Admin sees every page", () => {
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES, true))).toEqual([...PAGE_ORDER]);
  });

  test("a signed-in person without capabilities sees none", () => {
    expect(visiblePages(me([]))).toEqual([]);
  });

  test("an operator key sees the pages its scopes open, never workspaces, operator keys or the built-in Store", () => {
    const key: Pick<AdminMe, "organization" | "user"> = {
      organization: { capabilities: ["organization.incidents.read", "organization.testing.read"] },
      user: null,
    };
    expect(visiblePages(key)).toEqual(["incidents", "test-runs", "routine-catalog", "system-health"]);
  });

  test("a requested page falls back to the default when it is not visible", () => {
    expect(resolvePage("workspaces", ["incidents"])).toBe("incidents");
    expect(resolvePage("incidents", ["home", "incidents"])).toBe("incidents");
    expect(resolvePage(null, [])).toBeNull();
  });
});
