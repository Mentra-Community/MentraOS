import { ORGANIZATION_CAPABILITIES, type OrganizationCapability } from "@mentra/workspace-contract";
import { describe, expect, test } from "bun:test";
import { PAGE_ORDER, resolvePage, visiblePages, type AdminMe, type AdminPageKey } from "./admin-access";

function me(capabilities: readonly OrganizationCapability[], isOrganizationAdmin = false): Pick<AdminMe, "organization" | "user"> {
  return {
    organization: { capabilities: [...capabilities] },
    user: { mentraUserId: "mu_1", email: "a@example.test", emailVerified: true, isOrganizationAdmin },
  };
}

describe("the admin portal's pages follow capabilities", () => {
  test("an Organization Admin sees exactly the operations pages and then the audit log, and opens on incidents", () => {
    const pages: AdminPageKey[] = ["incidents", "test-runs", "routine-catalog", "system-health", "workspaces", "operator-keys", "audit"];
    expect([...PAGE_ORDER]).toEqual(pages);
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true));
    expect(visible).toEqual(pages);
    expect(resolvePage(null, visible)).toBe("incidents");
  });

  test("a signed-in person without capabilities sees none", () => {
    expect(visiblePages(me([]))).toEqual([]);
  });

  test("the audit log needs an Organization Admin who is a person, whatever capabilities are held", () => {
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES))).not.toContain("audit");
    expect(visiblePages(me([], true))).toEqual(["audit"]);
  });

  test("an operator key sees the pages its scopes open, never workspaces, operator keys or the audit log", () => {
    const key: Pick<AdminMe, "organization" | "user"> = {
      organization: { capabilities: ["organization.incidents.read", "organization.testing.read"] },
      user: null,
    };
    expect(visiblePages(key)).toEqual(["incidents", "test-runs", "routine-catalog", "system-health"]);
    // Even a key holding every capability: no capability opens the audit log.
    const everything: Pick<AdminMe, "organization" | "user"> = {
      organization: { capabilities: [...ORGANIZATION_CAPABILITIES] },
      user: null,
    };
    expect(visiblePages(everything)).not.toContain("audit");
    expect(resolvePage("audit", visiblePages(everything))).toBe("incidents");
  });

  test("a requested page falls back to the default when it is not visible", () => {
    expect(resolvePage("workspaces", ["incidents"])).toBe("incidents");
    expect(resolvePage("audit", ["incidents", "test-runs"])).toBe("incidents");
    expect(resolvePage("incidents", ["incidents", "audit"])).toBe("incidents");
    expect(resolvePage(null, [])).toBeNull();
  });
});
