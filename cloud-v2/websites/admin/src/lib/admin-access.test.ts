import { ORGANIZATION_CAPABILITIES, type OrganizationCapability } from "@mentra/workspace-contract";
import { describe, expect, test } from "bun:test";
import { PAGE_ORDER, resolvePage, visiblePages, type AdminMe, type AdminPageKey } from "./admin-access";

function me(
  capabilities: readonly OrganizationCapability[],
  isOrganizationAdmin = false,
  fleet?: { installed: boolean },
): Pick<AdminMe, "organization" | "user" | "fleet"> {
  return {
    organization: { capabilities: [...capabilities] },
    user: { mentraUserId: "mu_1", email: "a@example.test", emailVerified: true, isOrganizationAdmin },
    ...(fleet ? { fleet } : {}),
  };
}

describe("the admin portal's pages follow capabilities", () => {
  test("an Organization Admin sees exactly the operations pages and then the audit log, and opens on incidents", () => {
    const pages: AdminPageKey[] = ["incidents", "test-runs", "routine-catalog", "system-health", "workspaces", "operator-keys", "audit"];
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true));
    expect(visible).toEqual(pages);
    expect(resolvePage(null, visible)).toBe("incidents");
  });

  test("the Fleet page follows the incident system in navigation order", () => {
    expect([...PAGE_ORDER]).toEqual([
      "incidents", "fleet", "test-runs", "routine-catalog", "system-health", "workspaces", "operator-keys", "audit",
    ]);
  });

  test("an Organization Admin sees the Fleet page, right after the incident system, once Fleet is installed", () => {
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true, { installed: true }));
    expect(visible).toEqual([
      "incidents", "fleet", "test-runs", "routine-catalog", "system-health", "workspaces", "operator-keys", "audit",
    ]);
    expect(resolvePage("fleet", visible)).toBe("fleet");
  });

  test("the Fleet page is hidden when Fleet is not installed, or the answer is missing", () => {
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES, true, { installed: false }))).not.toContain("fleet");
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES, true))).not.toContain("fleet");
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true, { installed: false }));
    expect(resolvePage("fleet", visible)).toBe("incidents");
  });

  test("the Fleet page needs organization.fleet.administer even when Fleet is installed", () => {
    const withoutFleet = ORGANIZATION_CAPABILITIES.filter(capability => capability !== "organization.fleet.administer");
    expect(visiblePages(me(withoutFleet, true, { installed: true }))).not.toContain("fleet");
    expect(visiblePages(me([], false, { installed: true }))).toEqual([]);
    expect(visiblePages(me(["organization.fleet.administer"], false, { installed: true }))).toEqual(["fleet"]);
  });

  test("a signed-in person without capabilities sees none", () => {
    expect(visiblePages(me([]))).toEqual([]);
  });

  test("the audit log needs an Organization Admin who is a person, whatever capabilities are held", () => {
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES))).not.toContain("audit");
    expect(visiblePages(me([], true))).toEqual(["audit"]);
  });

  test("an operator key sees the pages its scopes open, never workspaces, operator keys or the audit log", () => {
    const key: Pick<AdminMe, "organization" | "user" | "fleet"> = {
      organization: { capabilities: ["organization.incidents.read", "organization.testing.read"] },
      user: null,
      fleet: { installed: true },
    };
    expect(visiblePages(key)).toEqual(["incidents", "test-runs", "routine-catalog", "system-health"]);
    // Even a key holding every capability: no capability opens the audit log.
    const everything: Pick<AdminMe, "organization" | "user" | "fleet"> = {
      organization: { capabilities: [...ORGANIZATION_CAPABILITIES] },
      user: null,
      fleet: { installed: true },
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
