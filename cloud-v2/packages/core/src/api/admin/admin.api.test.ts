/**
 * @fileoverview The admin API's gates, without a database.
 *
 * The principal is placed on the context directly (what `principalAuth` would have cached), so these
 * pin which organization capability each admin route needs and how a caller is refused. A request
 * the gate lets through is recognised by an early validation answer (400) or a static one (200),
 * which come before any I/O. The real admin app against a local replica set, with real identities,
 * credentials and workspaces, is covered by `tests/admin-capabilities.integration.test.ts`.
 */

import {ORGANIZATION_CAPABILITIES, OPERATOR_KEY_SCOPES, type CorePrincipal, type OrganizationCapability} from "@mentra/workspace-contract"
import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import {OauthError} from "../../types/oauth.types"
import type {AppEnv} from "../../types/hono.types"
import adminApi from "./admin.api"
import supportProfiles from "./support-profiles.api"

const WORKOS_KEYS = ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"] as const
const savedEnv = Object.fromEntries(WORKOS_KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  // With WorkOS unconfigured, a request carrying no principal can never become one.
  for (const key of WORKOS_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of WORKOS_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

function person(isOrganizationAdmin: boolean): CorePrincipal {
  return {
    kind: "user",
    organizationId: "local",
    mentraUserId: "mu_1",
    email: "person@example.test",
    emailVerified: true,
    name: null,
    workosUserId: "workos_1",
    isOrganizationAdmin,
  }
}

function key(credentialKind: "organization" | "workspace", scopes: string[]): CorePrincipal {
  return {
    kind: "credential",
    organizationId: "local",
    credentialId: "01HZKEY",
    credentialKind,
    workspaceId: credentialKind === "workspace" ? "ws_1" : null,
    scopes,
    packageNames: [],
    label: "ci key",
  }
}

/** The principal a request stands for, named by a header; no header, no principal. */
const principals = new Map<string, CorePrincipal>()

const root = new Hono<AppEnv>()
root.use("*", async (c, next) => {
  const principal = principals.get(c.req.header("x-test-principal") ?? "")
  if (principal) c.set("principal", principal)
  await next()
})
root.route("/api/admin", adminApi)
// What `createApp` does with a validation failure.
root.onError((err, c) => {
  if (err instanceof OauthError) return c.json({error: err.code}, err.httpStatus as 400)
  throw err
})

function as(name: string, principal: CorePrincipal): string {
  principals.set(name, principal)
  return name
}

async function status(as: string | null, method: string, path: string, headers: Record<string, string> = {}) {
  const response = await root.request(`http://localhost/api/admin${path}`, {
    method,
    headers: {...(as ? {"x-test-principal": as} : {}), ...headers},
  })
  await response.arrayBuffer()
  return response.status
}

type Route = [method: string, path: string]

/** Every admin route, by the capability that opens it. */
const ROUTES: Partial<Record<OrganizationCapability, Route[]>> = {
  "organization.incidents.read": [
    ["GET", "/reports"],
    ["GET", "/reports/rep_1"],
    ["GET", "/reports/rep_1/artifacts/art_1"],
    ["HEAD", "/reports/rep_1/artifacts/art_1"],
  ],
  "organization.supportProfiles.read": [["GET", "/support-profiles/lookup?email=a%40example.test"]],
  "organization.testing.read": [
    ["GET", "/test-runs"],
    ["GET", "/test-runs/activity"],
    ["GET", "/test-runs/health"],
    ["GET", "/test-runs/health/host-1"],
    ["GET", "/test-runs/history/list"],
    ["GET", "/test-runs/suite-index/list"],
    ["GET", "/test-runs/suites/suite-1"],
    ["GET", "/test-runs/restoration/list"],
    ["GET", "/test-runs/reruns/rerun-1"],
    ["GET", "/test-runs/run-1"],
    ["GET", "/test-runs/run-1/assets/asset-1"],
    ["HEAD", "/test-runs/run-1/assets/asset-1"],
    ["GET", "/routine-catalog"],
    ["GET", "/routine-catalog/results"],
    ["GET", "/routine-catalog/results/by-run/run-1"],
    ["HEAD", "/routine-catalog/results/by-run/run-1/assets/asset-1"],
    ["GET", "/routine-catalog/routine-1/android"],
    ["GET", "/test-routines"],
    ["GET", "/test-builds?channel=dev"],
  ],
  "organization.testing.manage": [
    ["POST", "/test-dispatches"],
    ["POST", "/test-dispatches/picker"],
    ["POST", "/test-runs/reruns/preview"],
    ["POST", "/test-runs/reruns/individual"],
    ["POST", "/test-runs/reruns/submit"],
    ["PATCH", "/routines/routine-1/platforms/android/preferences"],
  ],
}

/**
 * One request per capability that the gate lets through and the handler answers before any I/O:
 * a validation failure (400) or a static body (200).
 */
const OPEN_PROBE: Partial<Record<OrganizationCapability, {route: Route; status: number}>> = {
  "organization.incidents.read": {route: ["GET", "/reports?kind=nonsense"], status: 400},
  "organization.supportProfiles.read": {route: ["GET", "/support-profiles/lookup"], status: 400},
  "organization.testing.read": {route: ["GET", "/test-runs/_not-an-identity"], status: 400},
  "organization.testing.manage": {route: ["POST", "/test-dispatches"], status: 400},
}

const GATED = Object.keys(ROUTES) as OrganizationCapability[]
const ALL_ROUTES = GATED.flatMap(capability =>
  ROUTES[capability]!.map(([method, path]) => ({capability, method, path})),
)

describe("admin API without a principal", () => {
  test("/health is open", async () => {
    const response = await root.request("http://localhost/api/admin/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({status: "ok", service: "cloud-core-admin"})
  })

  test("every other route, /me included, is 401", async () => {
    expect(await status(null, "GET", "/me")).toBe(401)
    for (const {method, path} of ALL_ROUTES) expect([method, path, await status(null, method, path)]).toEqual([method, path, 401])
  })

  test("a bearer that is not a Core credential and no WorkOS session is 401, even a worker token", async () => {
    for (const {method, path} of ALL_ROUTES) {
      const answered = await status(null, method, path, {authorization: "Bearer synthetic-worker-token"})
      expect([method, path, answered]).toEqual([method, path, 401])
    }
  })
})

describe("admin API capability gates", () => {
  test("each capability opens its own routes and no others", async () => {
    for (const capability of GATED) {
      const holder = as(`only:${capability}`, key("organization", [capability]))
      for (const {capability: needed, method, path} of ALL_ROUTES) {
        // A route it may use answers past the gate, so only the denials are exact here.
        if (needed !== capability) expect([capability, method, path, await status(holder, method, path)]).toEqual([capability, method, path, 403])
      }
      const {route, status: open} = OPEN_PROBE[capability]!
      expect([capability, ...route, await status(holder, ...route)]).toEqual([capability, ...route, open])
    }
  })

  test("no other capability stands in for the one a route needs, reading and managing tests included", async () => {
    for (const capability of GATED) {
      const holder = as(`all-but:${capability}`, key("organization", OPERATOR_KEY_SCOPES.filter(scope => scope !== capability)))
      for (const [method, path] of ROUTES[capability]!) {
        expect([capability, method, path, await status(holder, method, path)]).toEqual([capability, method, path, 403])
      }
    }
  })

  test("a person who is not an Organization Admin and a workspace credential are refused everywhere", async () => {
    const member = as("member", person(false))
    // A workspace credential never has organization capabilities, whatever scopes its row carries.
    const workspaceKey = as("workspace-key", key("workspace", [...ORGANIZATION_CAPABILITIES]))
    for (const holder of [member, workspaceKey]) {
      for (const {method, path} of ALL_ROUTES) {
        expect([holder, method, path, await status(holder, method, path)]).toEqual([holder, method, path, 403])
      }
    }
  })

  test("an Organization Admin passes every gate", async () => {
    const admin = as("admin", person(true))
    for (const capability of GATED) {
      const {route, status: open} = OPEN_PROBE[capability]!
      expect([capability, ...route, await status(admin, ...route)]).toEqual([capability, ...route, open])
    }
  })

  test("scopes outside the operator scopes open nothing", async () => {
    const stray = as("stray", key("organization", ["organization.workspaces.administer", "organization.credentials.manage"]))
    for (const {method, path} of ALL_ROUTES) {
      expect([method, path, await status(stray, method, path)]).toEqual([method, path, 403])
    }
  })
})

describe("GET /api/admin/me", () => {
  async function me(as: string) {
    const response = await root.request("http://localhost/api/admin/me", {headers: {"x-test-principal": as}})
    return {status: response.status, body: await response.json()}
  }

  test("an operator key sees its credential, the capabilities it holds in a stable order and no workspaces", async () => {
    const operator = as("operator", key("organization", ["organization.testing.read", "organization.incidents.read"]))
    expect(await me(operator)).toEqual({
      status: 200,
      body: {
        authenticated: true,
        user: null,
        credential: {credentialId: "01HZKEY", label: "ci key"},
        organization: {
          organizationId: "local",
          capabilities: ["organization.incidents.read", "organization.testing.read"],
        },
        workspaces: [],
      },
    })
  })

  test("a workspace credential is a principal with no organization capabilities", async () => {
    const workspaceKey = as("workspace-key", key("workspace", ["miniapps.publish", "organization.incidents.read"]))
    expect(await me(workspaceKey)).toEqual({
      status: 200,
      body: {
        authenticated: true,
        user: null,
        credential: {credentialId: "01HZKEY", label: "ci key"},
        organization: {organizationId: "local", capabilities: []},
        workspaces: [],
      },
    })
  })
})

describe("a handler mounted without its gate", () => {
  test("the support-profile lookup fails closed rather than auditing an anonymous reader", async () => {
    const response = await supportProfiles.request("http://localhost/lookup?email=nobody%40example.test")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })
})
