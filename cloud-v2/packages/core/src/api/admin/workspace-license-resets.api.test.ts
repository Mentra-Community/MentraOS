import {afterEach, describe, expect, spyOn, test} from "bun:test"
import {Hono} from "hono"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import * as resets from "../../services/licenses/workspace-license-reset.service"
import type {CorePrincipal} from "../../services/signin/principal.service"
import {WorkspaceError} from "../../services/workspaces/workspace-error"
import type {AppEnv} from "../../types/hono.types"
import {verifyForwardedPrincipal} from "@mentra/workspace-contract/server"
import resetApi from "./workspace-license-resets.api"

const saved = {...process.env}
const spies: Array<{mockRestore(): void}> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const key of ["CLOUD_CORE_ENVIRONMENT", "CLOUD_CORE_BILLING_URL", "CLOUD_CORE_BILLING_SECRET"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  }
})
const person = (admin: boolean): CorePrincipal => ({kind: "user", mentraUserId: "mu_admin", tenantId: "mentra", email: "admin@example.test", emailVerified: true, isOrganizationAdmin: admin, via: "bearer"})
function app(principal: CorePrincipal) {
  const root = new Hono<AppEnv>()
  root.use("*", async (c, next) => {c.set("principal", principal); c.set("reqId", "reset-test"); await next()})
  root.onError((error, c) => error instanceof WorkspaceError ? c.json({error: error.code}, error.status as 400) : c.json({error: error.message}, 500))
  return root.route("/api/admin/workspace-license-resets", resetApi)
}
const path = "/api/admin/workspace-license-resets/ws_target"
const request = (body: unknown) => ({method: "POST", headers: {authorization: "Bearer test", "content-type": "application/json"}, body: JSON.stringify(body)})
const body = {confirmWorkspaceId: "ws_target"}

describe("non-production workspace license reset API", () => {
  test("production and other environments refuse both reads and writes before touching data", async () => {
    const preview = spyOn(resets, "licenseResetPreview"); spies.push(preview)
    for (const environment of ["prod", "production", "test", ""]) {
      process.env.CLOUD_CORE_ENVIRONMENT = environment
      expect((await app(person(true)).request(path, {headers: {authorization: "Bearer test"}})).status).toBe(403)
      expect((await app(person(true)).request(path, request(body))).status).toBe(403)
    }
    expect(preview).not.toHaveBeenCalled()
  })
  test("a workspace owner without organization-admin access cannot reset", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"
    expect((await app(person(false)).request(path, request(body))).status).toBe(403)
  })
  test("confirmation must match this workspace before billing is contacted", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"
    const preview = spyOn(resets, "licenseResetPreview"); spies.push(preview)
    for (const invalid of [{confirmWorkspaceId: "ws_other"}, {}]) {
      expect((await app(person(true)).request(path, request(invalid))).status).toBe(400)
    }
    expect(preview).not.toHaveBeenCalled()
  })
  test("provider failure cannot end local licenses; success forwards the real principal and exact workspace", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"
    process.env.CLOUD_CORE_BILLING_URL = "https://billing.test/billing"
    process.env.CLOUD_CORE_BILLING_SECRET = "reset-secret"
    spies.push(spyOn(resets, "licenseResetPreview").mockResolvedValue({workspaceId: "ws_target", name: "Target", products: 1, licenses: 3, assignments: 1}))
    spies.push(spyOn(AdminActionAuditLogModel, "create").mockResolvedValue({} as never))
    const finish = spyOn(resets, "finishLicenseReset").mockResolvedValue({endedProducts: 1, releasedAssignments: 1, canceledSubscriptions: 1, expiredCheckouts: 0}); spies.push(finish)
    let fails = true
    const network = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init)
      const url = new URL(req.url)
      const text = await req.text()
      const principal = verifyForwardedPrincipal({method: req.method, pathWithQuery: url.pathname + url.search, body: text, headers: req.headers}, ["reset-secret"])
      expect(principal).toMatchObject({kind: "user", mentraUserId: "mu_admin", isOrganizationAdmin: true, scope: {kind: "workspace", workspaceId: "ws_target"}})
      expect(url.pathname).toBe("/billing/v1/portal/workspaces/ws_target/reset-licenses")
      return Response.json(fails ? {error: "billing_unavailable"} : {licenseIds: ["lic_target"], canceledSubscriptions: 1, expiredCheckouts: 0}, {status: fails ? 503 : 200})
    }) as typeof fetch); spies.push(network)
    expect((await app(person(true)).request(path, request(body))).status).toBe(503)
    expect(finish).not.toHaveBeenCalled()
    fails = false
    for (const environment of ["dev", "staging"]) {
      process.env.CLOUD_CORE_ENVIRONMENT = environment
      expect((await app(person(true)).request(path, request(body))).status).toBe(200)
    }
    expect(finish).toHaveBeenCalledTimes(2)
  })
})
