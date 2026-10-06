import { describe, expect, test } from "bun:test";
import type { OrganizationCapability, PrincipalResponse } from "@mentra/workspace-contract";
import { resolvePage, visiblePages, type AdminMe } from "./admin-access";

const workspace: PrincipalResponse["workspaces"][number] = {
  organizationId: "org_test",
  workspaceId: "ws_acme",
  name: "Acme Robotics",
  status: "active",
  authorizationRevision: 3,
  membership: { membershipId: "wm_self", role: "member" },
  capabilities: ["workspace.read", "miniapps.access"],
};

function me(capabilities: OrganizationCapability[], workspaces: AdminMe["workspaces"] = []): AdminMe {
  return {
    authenticated: true,
    user: { mentraUserId: "u_self", email: "sam@acme.test" },
    credential: null,
    organization: { organizationId: "org_test", capabilities },
    workspaces,
  };
}

describe("which admin pages a principal sees", () => {
  test("each page follows its own capability", () => {
    expect(visiblePages(me(["organization.incidents.read"]))).toEqual(["incidents"]);
    expect(visiblePages(me(["organization.testing.read"]))).toEqual(["test-runs", "routine-catalog", "system-health"]);
    expect(visiblePages(me(["organization.credentials.manage"]))).toEqual(["operator-keys"]);
    expect(visiblePages(me(["organization.workspaces.administer"]))).toEqual(["workspaces"]);
  });

  test("capabilities that open no page open none", () => {
    expect(visiblePages(me(["organization.supportProfiles.read", "organization.testing.manage"]))).toEqual([]);
  });

  test("Workspaces is shown to anyone in a workspace, whatever else they hold", () => {
    expect(visiblePages(me([], [workspace]))).toEqual(["workspaces"]);
    expect(visiblePages(me(["organization.incidents.read"], [workspace]))).toEqual(["incidents", "workspaces"]);
  });

  test("a person with nothing sees nothing", () => {
    expect(visiblePages(me([]))).toEqual([]);
  });

  test("an Organization Admin sees every page, in navigation order", () => {
    expect(
      visiblePages(
        me([
          "organization.workspaces.administer",
          "organization.credentials.manage",
          "organization.incidents.read",
          "organization.supportProfiles.read",
          "organization.testing.read",
          "organization.testing.manage",
        ]),
      ),
    ).toEqual(["incidents", "test-runs", "routine-catalog", "system-health", "workspaces", "operator-keys"]);
  });

  test("an invitation link opens Workspaces for someone who is not in a workspace yet", () => {
    expect(visiblePages(me([]), { pendingInvite: true })).toEqual(["workspaces"]);
    expect(visiblePages(me(["organization.incidents.read"]), { pendingInvite: true })).toEqual(["incidents", "workspaces"]);
  });
});

describe("resolving the page to show", () => {
  const visible = ["test-runs", "workspaces"] as const;

  test("a visible page is kept", () => {
    expect(resolvePage("workspaces", visible)).toBe("workspaces");
  });

  test("a hidden page (a deep link) falls back to the first visible one", () => {
    expect(resolvePage("operator-keys", visible)).toBe("test-runs");
    expect(resolvePage("incidents", visible)).toBe("test-runs");
  });

  test("no request shows the default page", () => {
    expect(resolvePage(null, visible)).toBe("test-runs");
  });

  test("nothing visible resolves to no page", () => {
    expect(resolvePage("incidents", [])).toBeNull();
    expect(resolvePage(null, [])).toBeNull();
  });
});
