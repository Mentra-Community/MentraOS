/**
 * @fileoverview Principal gate tests that need no database.
 *
 * The principal is placed on the context directly (what `principalAuth` would
 * have cached), so these pin the gating rules and status mapping on their own.
 * Resolution from real WorkOS identities, memberships and credentials, and
 * workspace authorization, are covered against a local replica set in
 * `tests/principal-auth.integration.test.ts`.
 */

import {ORGANIZATION_CAPABILITIES, type CorePrincipal, type OrganizationCapability} from "@mentra/workspace-contract"
import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import {organizationCapabilities} from "../../services/workspaces/authorization.service"
import type {AppEnv} from "../../types/hono.types"
import {
  principalAuth,
  principalLabel,
  requireOrganizationCapability,
  requireUserPrincipal,
  requireWorkspaceCapability,
  userActor,
} from "./principal.middleware"

function user(overrides: Partial<Extract<CorePrincipal, {kind: "user"}>> = {}): CorePrincipal {
  return {
    kind: "user",
    organizationId: "local",
    mentraUserId: "mu_1",
    email: "dev@example.test",
    emailVerified: true,
    workosUserId: "workos_1",
    isOrganizationAdmin: false,
    ...overrides,
  }
}

function credential(overrides: Partial<Extract<CorePrincipal, {kind: "credential"}>> = {}): CorePrincipal {
  return {
    kind: "credential",
    organizationId: "local",
    credentialId: "01HZ",
    credentialKind: "workspace",
    workspaceId: "ws_1",
    scopes: ["miniapps.publish"],
    packageNames: [],
    label: "My CI key",
    ...overrides,
  }
}

const WORKOS_KEYS = ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"] as const
const savedEnv = Object.fromEntries(WORKOS_KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  // With WorkOS unconfigured, a request with no Core credential can never become a principal.
  for (const key of WORKOS_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of WORKOS_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

/** An app whose requests carry `principal`, as if already resolved. */
function appFor(principal: CorePrincipal | null) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    if (principal) c.set("principal", principal)
    await next()
  })
  app.get("/me", principalAuth, c => c.json({principal: c.get("principal")}))
  app.get("/people-only", requireUserPrincipal, c => c.json({actor: userActor(c)}))
  app.get("/incidents", requireOrganizationCapability("organization.incidents.read"), c => c.json({ok: true}))
  app.get("/testing", requireOrganizationCapability("organization.testing.manage"), c => c.json({ok: true}))
  app.get("/no-param", requireWorkspaceCapability("workspace.read"), c => c.json({ok: true}))
  return app
}

const get = (principal: CorePrincipal | null, path: string, headers: Record<string, string> = {}) =>
  appFor(principal).request(`http://localhost${path}`, {headers})

describe("organizationCapabilities", () => {
  test("an organization admin has every organization capability, anyone else none", () => {
    expect(organizationCapabilities(user({isOrganizationAdmin: true}))).toEqual(new Set(ORGANIZATION_CAPABILITIES))
    expect(organizationCapabilities(user()).size).toBe(0)
  })

  test("an operator key has the operator scopes it carries and nothing else", () => {
    const key = credential({
      credentialKind: "organization",
      workspaceId: null,
      scopes: [
        "organization.incidents.read",
        "organization.testing.read",
        // Not operator scopes: a stored row must never turn these into capabilities.
        "organization.workspaces.administer",
        "organization.credentials.manage",
        "miniapps.publish",
        "workspace.delete",
        "bogus",
      ],
    })

    expect(organizationCapabilities(key)).toEqual(
      new Set<OrganizationCapability>(["organization.incidents.read", "organization.testing.read"]),
    )
  })

  test("a workspace credential has none, whatever its scopes say", () => {
    expect(organizationCapabilities(credential({scopes: ["organization.incidents.read"]})).size).toBe(0)
  })
})

describe("principalAuth", () => {
  test("passes a request that already has a principal", async () => {
    const response = await get(user(), "/me")

    expect(response.status).toBe(200)
    expect(((await response.json()) as any).principal).toMatchObject({kind: "user", mentraUserId: "mu_1"})
  })

  test("no credentials is 401", async () => {
    const response = await get(null, "/me")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })

  test("a Core credential that cannot validate is 401", async () => {
    for (const token of ["mak_garbage", "msk_local_not-a-real-key"]) {
      const response = await get(null, "/me", {authorization: `Bearer ${token}`})
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({error: "unauthorized"})
    }
  })
})

describe("requireUserPrincipal", () => {
  test("passes a signed-in person, and userActor describes them for the services", async () => {
    const response = await get(user({isOrganizationAdmin: true}), "/people-only")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      actor: {
        kind: "user",
        mentraUserId: "mu_1",
        email: "dev@example.test",
        emailVerified: true,
        name: null,
        isOrganizationAdmin: true,
      },
    })
  })

  test("a workspace key and an operator key are 403, whatever scopes they carry", async () => {
    for (const principal of [
      credential(),
      credential({credentialKind: "organization", workspaceId: null, scopes: ["organization.incidents.read"]}),
    ]) {
      const response = await get(principal, "/people-only")
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({error: "forbidden"})
    }
  })

  test("no principal is 401, not 403", async () => {
    const response = await get(null, "/people-only")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })
})

describe("requireOrganizationCapability", () => {
  test("passes a principal that holds the capability and returns 403 for one that does not", async () => {
    const key = credential({
      credentialKind: "organization",
      workspaceId: null,
      scopes: ["organization.incidents.read"],
    })

    expect((await get(key, "/incidents")).status).toBe(200)
    const denied = await get(key, "/testing")
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({error: "forbidden"})
  })

  test("an organization admin passes every gate", async () => {
    const admin = user({isOrganizationAdmin: true})

    expect((await get(admin, "/incidents")).status).toBe(200)
    expect((await get(admin, "/testing")).status).toBe(200)
  })

  test("a workspace credential and an ordinary user are 403", async () => {
    for (const principal of [credential(), user()]) {
      const response = await get(principal, "/incidents")
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({error: "forbidden"})
    }
  })

  test("no principal is 401, not 403", async () => {
    const response = await get(null, "/incidents")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })
})

describe("requireWorkspaceCapability", () => {
  test("a route without the workspace parameter authorizes nothing, even for an organization admin", async () => {
    const response = await get(user({isOrganizationAdmin: true}), "/no-param")

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: "workspace_not_found"})
  })

  test("no principal is 401", async () => {
    const response = await get(null, "/no-param")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })
})

describe("principalLabel", () => {
  test("a user is their email, or their Mentra user id without one", () => {
    expect(principalLabel(user())).toBe("dev@example.test")
    expect(principalLabel(user({email: null}))).toBe("user:mu_1")
  })

  test("a credential is credential:<id>, never its token or name", () => {
    expect(principalLabel(credential())).toBe("credential:01HZ")
  })
})
