import {describe, expect, test} from "bun:test"
import type {WorkspaceCapability, WorkspaceRole} from "./capabilities"
import {
  OPERATOR_KEY_SCOPES,
  ORGANIZATION_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_ROLES,
  canChangeRole,
  capabilitiesForRole,
  roleAtLeast,
} from "./capabilities"

describe("capabilitiesForRole", () => {
  test("roles are cumulative", () => {
    expect(capabilitiesForRole("member").has("miniapps.publish")).toBe(false)
    expect(capabilitiesForRole("developer").has("miniapps.publish")).toBe(true)
    expect(capabilitiesForRole("developer").has("workspace.members.read")).toBe(false)
    expect(capabilitiesForRole("admin").has("fleet.read")).toBe(true)
    expect(capabilitiesForRole("admin").has("workspace.roles.managePrivileged")).toBe(false)
    expect(capabilitiesForRole("owner").has("workspace.delete")).toBe(true)
  })

  test("the owner holds every workspace capability and each role holds all the capabilities of the one below", () => {
    expect([...capabilitiesForRole("owner")].sort()).toEqual([...WORKSPACE_CAPABILITIES].sort())
    for (let i = 1; i < WORKSPACE_ROLES.length; i++) {
      const lower = capabilitiesForRole(WORKSPACE_ROLES[i - 1])
      const higher = capabilitiesForRole(WORKSPACE_ROLES[i])
      for (const capability of lower) expect(higher.has(capability)).toBe(true)
      expect(higher.size).toBeGreaterThan(lower.size)
    }
  })

  test("each role holds exactly the documented capability set", () => {
    const member: WorkspaceCapability[] = ["workspace.read", "miniapps.access"]
    const developer: WorkspaceCapability[] = [...member, "miniapps.publish", "miniapps.credentials.create"]
    const admin: WorkspaceCapability[] = [
      ...developer,
      "workspace.members.read",
      "workspace.members.manage",
      "workspace.settings.manage",
      "workspace.audit.read",
      "workspace.credentials.revoke",
      "fleet.read",
      "fleet.devices.manage",
      "miniapps.assign",
    ]
    const owner: WorkspaceCapability[] = [...admin, "workspace.roles.managePrivileged", "workspace.delete"]
    const expected: Record<WorkspaceRole, WorkspaceCapability[]> = {member, developer, admin, owner}
    for (const role of WORKSPACE_ROLES) {
      expect([...capabilitiesForRole(role)].sort()).toEqual([...expected[role]].sort())
    }
  })
})

describe("roleAtLeast", () => {
  test("orders roles from member up to owner", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true)
    expect(roleAtLeast("admin", "admin")).toBe(true)
    expect(roleAtLeast("developer", "admin")).toBe(false)
    expect(roleAtLeast("member", "member")).toBe(true)
    expect(roleAtLeast("member", "developer")).toBe(false)
  })
})

describe("canChangeRole", () => {
  test("admins move members and developers only; owners guard privileged roles on both sides", () => {
    expect(canChangeRole("admin", "member", "developer")).toBe(true)
    expect(canChangeRole("admin", null, "member")).toBe(true) // invite
    expect(canChangeRole("admin", "developer", null)).toBe(true) // remove
    expect(canChangeRole("admin", "member", "admin")).toBe(false) // grant privileged
    expect(canChangeRole("admin", "admin", "member")).toBe(false) // demote privileged
    expect(canChangeRole("admin", null, "admin")).toBe(false) // invite privileged
    expect(canChangeRole("owner", "admin", "owner")).toBe(true)
    expect(canChangeRole("developer", "member", "developer")).toBe(false)
  })

  test("only owners can remove or grant owner and admin", () => {
    expect(canChangeRole("admin", "owner", null)).toBe(false)
    expect(canChangeRole("admin", null, "owner")).toBe(false)
    expect(canChangeRole("owner", "owner", null)).toBe(true)
    expect(canChangeRole("owner", null, "owner")).toBe(true)
    expect(canChangeRole("member", null, "member")).toBe(false)
  })
})

describe("operator key scopes", () => {
  test("never include workspace administration and are all organization capabilities", () => {
    expect(OPERATOR_KEY_SCOPES).not.toContain("organization.workspaces.administer")
    expect(OPERATOR_KEY_SCOPES).not.toContain("organization.credentials.manage")
    for (const scope of OPERATOR_KEY_SCOPES) expect(ORGANIZATION_CAPABILITIES).toContain(scope)
  })
})
