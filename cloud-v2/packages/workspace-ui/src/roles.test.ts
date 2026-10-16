import { describe, expect, test } from "bun:test";
import { capabilitiesForRole, WORKSPACE_ROLES } from "@mentra/workspace-contract";
import { actsAsOrganizationAdmin, assignableRoles, can, canCreateCredentials, effectiveRole, roleOptions } from "./roles";
import { detailFor, organizationAdminDetail } from "./test-fixtures";

describe("effectiveRole", () => {
  test("is the member's role when their capabilities are exactly that role's", () => {
    for (const role of WORKSPACE_ROLES) expect(effectiveRole(detailFor(role))).toBe(role);
  });

  test("an organization admin with no membership is an owner", () => {
    expect(effectiveRole(organizationAdminDetail())).toBe("owner");
  });

  test("capabilities win over the membership role, as they do on the server", () => {
    const detail = { ...organizationAdminDetail(), membership: { membershipId: "wm_1", role: "member" as const } };
    expect(effectiveRole(detail)).toBe("owner");
  });

  test("no capabilities means no role", () => {
    expect(effectiveRole({ capabilities: [] })).toBeNull();
    expect(effectiveRole({ capabilities: ["workspace.members.read"] })).toBeNull();
  });
});

describe("assignableRoles and roleOptions", () => {
  test("an owner may set any other role, an admin only member and developer, others nothing", () => {
    expect(assignableRoles("owner", "member")).toEqual(["developer", "admin", "owner"]);
    expect(assignableRoles("admin", "member")).toEqual(["developer"]);
    expect(assignableRoles("admin", "developer")).toEqual(["member"]);
    expect(assignableRoles("admin", "admin")).toEqual([]);
    expect(assignableRoles("admin", "owner")).toEqual([]);
    expect(assignableRoles("developer", "member")).toEqual([]);
    expect(assignableRoles("member", "member")).toEqual([]);
    expect(assignableRoles(null, "member")).toEqual([]);
  });

  test("an invitation starts from no role", () => {
    expect(assignableRoles("owner", null)).toEqual([...WORKSPACE_ROLES]);
    expect(assignableRoles("admin", null)).toEqual(["member", "developer"]);
    expect(assignableRoles("developer", null)).toEqual([]);
  });

  test("a selector shows the current role plus what may be assigned, lowest role first", () => {
    expect(roleOptions("admin", "member")).toEqual(["member", "developer"]);
    expect(roleOptions("owner", "developer")).toEqual([...WORKSPACE_ROLES]);
    expect(roleOptions("developer", "member")).toEqual([]);
  });
});

describe("can", () => {
  test("reads the capability from the workspace detail", () => {
    expect(can(detailFor("admin"), "workspace.members.manage")).toBe(true);
    expect(can(detailFor("developer"), "workspace.members.manage")).toBe(false);
    expect(can(undefined, "workspace.read")).toBe(false);
  });
});

describe("canCreateCredentials", () => {
  test("needs a membership whose own role can publish, as Core does", () => {
    expect(canCreateCredentials(detailFor("developer"))).toBe(true);
    expect(canCreateCredentials(detailFor("admin"))).toBe(true);
    expect(canCreateCredentials(detailFor("owner"))).toBe(true);
    expect(canCreateCredentials(detailFor("member"))).toBe(false);
  });

  test("an organization admin outside the workspace, or in it as a plain member, cannot", () => {
    expect(canCreateCredentials(organizationAdminDetail())).toBe(false);
    expect(canCreateCredentials({ ...organizationAdminDetail(), membership: { membershipId: "wm_1", role: "member" } })).toBe(false);
    expect(canCreateCredentials({ ...organizationAdminDetail(), membership: { membershipId: "wm_1", role: "developer" } })).toBe(true);
    expect(canCreateCredentials(undefined)).toBe(false);
  });
});

describe("actsAsOrganizationAdmin", () => {
  const owner = [...capabilitiesForRole("owner")];
  test("an Organization Admin whose membership grants less, or who has none, acts as one", () => {
    expect(actsAsOrganizationAdmin({ capabilities: owner, membership: { membershipId: "wm_1", role: "member" }, organizationAdmin: true })).toBe(true);
    expect(actsAsOrganizationAdmin({ capabilities: owner, membership: null, organizationAdmin: true })).toBe(true);
  });

  test("an owner's powers are their own, and nobody else's come from the organization", () => {
    expect(actsAsOrganizationAdmin({ capabilities: owner, membership: { membershipId: "wm_1", role: "owner" }, organizationAdmin: true })).toBe(false);
    expect(
      actsAsOrganizationAdmin({
        capabilities: [...capabilitiesForRole("member")],
        membership: { membershipId: "wm_1", role: "member" },
        organizationAdmin: false,
      }),
    ).toBe(false);
  });

  test("without the flag (an older server) only owner capabilities with no membership say so", () => {
    expect(actsAsOrganizationAdmin({ capabilities: owner, membership: null })).toBe(true);
    expect(actsAsOrganizationAdmin({ capabilities: [...capabilitiesForRole("admin")], membership: { membershipId: "wm_1", role: "admin" } })).toBe(false);
  });
});
