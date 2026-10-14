/**
 * @fileoverview `GET /api/admin/me`: who is calling, what they may do, and whether Fleet is installed.
 *
 * The admin app is mounted behind a middleware that sets the principal, which `principalAuth` accepts
 * as already resolved, so no sign-in or database is involved: the person's workspace list is stubbed.
 */

import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {OPERATOR_KEY_SCOPES, ORGANIZATION_CAPABILITIES} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import type {CorePrincipal} from "../../services/signin/principal.service"
import type {AppEnv} from "../../types/hono.types"
import admin, {type AdminMeResponse} from "./admin.api"

const SETTINGS = [
  "CLOUD_CORE_FLEET_URL",
  "CLOUD_CORE_FLEET_SECRET",
  "CLOUD_CORE_ENABLED_FEATURES",
  "CLOUD_CORE_ENVIRONMENT",
] as const
const saved = Object.fromEntries(SETTINGS.map(name => [name, process.env[name]]))

const organizationAdmin: CorePrincipal = {
  kind: "user",
  mentraUserId: "mu_admin",
  tenantId: "mentra",
  email: "admin@example.test",
  emailVerified: true,
  isOrganizationAdmin: true,
  via: "session",
}
const member: CorePrincipal = {...organizationAdmin, mentraUserId: "mu_member", isOrganizationAdmin: false}

const operatorKey = (scopes: string[]): CorePrincipal => ({
  kind: "credential",
  credentialId: "cred_operator",
  credentialKind: "organization",
  workspaceId: null,
  scopes,
  packageNames: [],
  label: "operator key",
})
const workspaceKey: CorePrincipal = {
  kind: "credential",
  credentialId: "cred_workspace",
  credentialKind: "workspace",
  workspaceId: "ws_1",
  scopes: ["workspace.read"],
  packageNames: [],
  label: "workspace key",
}

async function me(principal: CorePrincipal): Promise<AdminMeResponse> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("principal", principal)
    await next()
  })
  app.route("/api/admin", admin)
  const response = await app.request("/api/admin/me")
  expect(response.status).toBe(200)
  return (await response.json()) as AdminMeResponse
}

let memberships: ReturnType<typeof spyOn>

beforeEach(() => {
  for (const name of SETTINGS) delete process.env[name]
  memberships = spyOn(WorkspaceMembershipModel, "find").mockImplementation((() => ({lean: async () => []})) as never)
})

afterEach(() => {
  memberships.mockRestore()
  for (const name of SETTINGS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe("GET /api/admin/me reports whether Fleet is installed", () => {
  test("not installed without a Fleet URL", async () => {
    expect((await me(organizationAdmin)).fleet).toEqual({installed: false})
  })

  test("installed when Fleet is configured", async () => {
    process.env.CLOUD_CORE_FLEET_URL = "https://mfm.example.test"
    process.env.CLOUD_CORE_FLEET_SECRET = "secret"
    expect((await me(organizationAdmin)).fleet).toEqual({installed: true})
  })

  test("installed but unusable still counts as installed, so the portal can say Fleet is unavailable", async () => {
    process.env.CLOUD_CORE_FLEET_URL = "https://mfm.example.test"
    expect((await me(organizationAdmin)).fleet).toEqual({installed: true})
  })

  test("not installed on a Private Cloud whose features do not list fleet.managed", async () => {
    process.env.CLOUD_CORE_FLEET_URL = "https://mfm.example.test"
    process.env.CLOUD_CORE_FLEET_SECRET = "secret"
    process.env.CLOUD_CORE_ENABLED_FEATURES = "call.unlimited:com.mentra.call"
    expect((await me(organizationAdmin)).fleet).toEqual({installed: false})

    process.env.CLOUD_CORE_ENABLED_FEATURES = "call.unlimited:com.mentra.call, fleet.managed"
    expect((await me(organizationAdmin)).fleet).toEqual({installed: true})
  })

  test("is the same answer for every principal, and never carries the URL or the secret", async () => {
    process.env.CLOUD_CORE_FLEET_URL = "https://mfm.example.test"
    process.env.CLOUD_CORE_FLEET_SECRET = "secret-value"
    for (const principal of [organizationAdmin, member, operatorKey([...OPERATOR_KEY_SCOPES]), workspaceKey]) {
      const body = await me(principal)
      expect(body.fleet).toEqual({installed: true})
      expect(JSON.stringify(body)).not.toContain("mfm.example.test")
      expect(JSON.stringify(body)).not.toContain("secret-value")
    }
  })
})

describe("GET /api/admin/me lists the organization capabilities", () => {
  test("an Organization Admin holds organization.fleet.administer, with every other organization capability", async () => {
    const body = await me(organizationAdmin)
    expect(body.organization.capabilities).toContain("organization.fleet.administer")
    expect(body.organization.capabilities).toEqual([...ORGANIZATION_CAPABILITIES])
    expect(body.user?.isOrganizationAdmin).toBe(true)
  })

  test("a person who is not an Organization Admin holds none", async () => {
    expect((await me(member)).organization.capabilities).toEqual([])
  })

  test("an operator key never holds it, even when asked for it as a scope", async () => {
    const all = await me(operatorKey([...OPERATOR_KEY_SCOPES]))
    expect(all.organization.capabilities).not.toContain("organization.fleet.administer")
    expect(all.organization.capabilities).toEqual([...OPERATOR_KEY_SCOPES])

    const forged = await me(operatorKey([...OPERATOR_KEY_SCOPES, "organization.fleet.administer"]))
    expect(forged.organization.capabilities).not.toContain("organization.fleet.administer")
    expect(forged.credential?.credentialKind).toBe("organization")
  })

  test("a workspace key holds no organization capability", async () => {
    expect((await me(workspaceKey)).organization.capabilities).toEqual([])
  })
})
