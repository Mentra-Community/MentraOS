import { ORGANIZATION_CAPABILITIES, type OrganizationCapability } from "@mentra/workspace-contract";
import { describe, expect, test } from "bun:test";
import { PAGE_ORDER, resolvePage, visiblePages, type AdminMe, type AdminPageKey } from "./admin-access";

function me(
  capabilities: readonly OrganizationCapability[],
  isOrganizationAdmin = false,
  fleet?: { installed: boolean },
  licenses?: { available: boolean },
): Pick<AdminMe, "organization" | "user" | "fleet" | "licenses"> {
  return {
    organization: { capabilities: [...capabilities] },
    user: { mentraUserId: "mu_1", email: "a@example.test", emailVerified: true, isOrganizationAdmin },
    ...(fleet ? { fleet } : {}),
    ...(licenses ? { licenses } : {}),
  };
}

describe("the admin portal's pages follow capabilities", () => {
  test("an Organization Admin sees exactly the operations pages and then the audit log, and opens on incidents", () => {
    const pages: AdminPageKey[] = ["incidents", "test-runs", "routine-catalog", "system-health", "workspaces", "operator-keys", "audit"];
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true));
    expect(visible).toEqual(pages);
    expect(resolvePage(null, visible)).toBe("incidents");
  });

  test("there is no Fleet page: Fleet Management opens in the workspace portal, from Workspaces", () => {
    expect([...PAGE_ORDER]).toEqual([
      "incidents", "test-runs", "routine-catalog", "system-health", "workspaces", "licenses", "operator-keys", "audit",
    ]);
    expect([...PAGE_ORDER] as string[]).not.toContain("fleet");
    // Installed or not, and whatever the principal holds, no page is offered for it.
    for (const fleet of [{ installed: true }, { installed: false }, undefined]) {
      expect(visiblePages(me(ORGANIZATION_CAPABILITIES, true, fleet)) as string[]).not.toContain("fleet");
    }
    // organization.fleet.administer alone opens nothing in the admin portal.
    expect(visiblePages(me(["organization.fleet.administer"], false, { installed: true }))).toEqual([]);
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true, { installed: true }));
    expect(resolvePage("fleet" as AdminPageKey, visible)).toBe("incidents");
  });

  test("an Organization Admin sees the Licenses page, right after Workspaces, once licenses are available", () => {
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true, undefined, { available: true }));
    expect(visible).toEqual([
      "incidents", "test-runs", "routine-catalog", "system-health", "workspaces", "licenses", "operator-keys", "audit",
    ]);
    expect(resolvePage("licenses", visible)).toBe("licenses");
  });

  test("the Licenses page is hidden on a Core with no billing and no licenses, or when the answer is missing", () => {
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES, true, undefined, { available: false }))).not.toContain("licenses");
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES, true))).not.toContain("licenses");
    const visible = visiblePages(me(ORGANIZATION_CAPABILITIES, true, undefined, { available: false }));
    expect(resolvePage("licenses", visible)).toBe("incidents");
  });

  test("the Licenses page needs organization.licenses.read even when licenses are available", () => {
    const without = ORGANIZATION_CAPABILITIES.filter(capability => capability !== "organization.licenses.read");
    expect(visiblePages(me(without, true, undefined, { available: true }))).not.toContain("licenses");
    expect(visiblePages(me([], false, undefined, { available: true }))).toEqual([]);
    expect(visiblePages(me(["organization.licenses.read"], false, undefined, { available: true }))).toEqual(["licenses"]);
  });

  test("a signed-in person without capabilities sees none", () => {
    expect(visiblePages(me([]))).toEqual([]);
  });

  test("the audit log needs an Organization Admin who is a person, whatever capabilities are held", () => {
    expect(visiblePages(me(ORGANIZATION_CAPABILITIES))).not.toContain("audit");
    expect(visiblePages(me([], true))).toEqual(["audit"]);
  });

  test("an operator key sees the pages its scopes open, never workspaces, operator keys or the audit log", () => {
    const key: Pick<AdminMe, "organization" | "user" | "fleet" | "licenses"> = {
      organization: { capabilities: ["organization.incidents.read", "organization.testing.read"] },
      user: null,
      fleet: { installed: true },
      licenses: { available: true },
    };
    expect(visiblePages(key)).toEqual(["incidents", "test-runs", "routine-catalog", "system-health"]);
    // Even a key holding every capability: no capability opens the audit log.
    const everything: Pick<AdminMe, "organization" | "user" | "fleet" | "licenses"> = {
      organization: { capabilities: [...ORGANIZATION_CAPABILITIES] },
      user: null,
      fleet: { installed: true },
      licenses: { available: true },
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
