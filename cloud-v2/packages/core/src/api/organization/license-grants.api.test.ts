import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {ORGANIZATION_CAPABILITIES, type LicenseGrant, type LicenseGrantEnded} from "@mentra/workspace-contract"
import {verifyForwardedPrincipal} from "@mentra/workspace-contract/server"
import {Hono} from "hono"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import type {CorePrincipal} from "../../services/signin/principal.service"
import {WorkspaceError} from "../../services/workspaces/workspace-error"
import * as workspaces from "../../services/workspaces/workspace.service"
import type {AppEnv} from "../../types/hono.types"
import {OauthError} from "../../types/oauth.types"
import {createOrganizationApi} from "./organization.api"

const SECRET = "license-grant-test-secret"
const WS = "ws_target"
const PATH = `/api/organization/workspaces/${WS}/license-grants`
const DAY = 24 * 60 * 60 * 1000

const saved = {...process.env}
const spies: Array<{mockRestore(): void}> = []
const spy = <T extends {mockRestore(): void}>(made: T): T => {
  spies.push(made)
  return made
}

const admin: CorePrincipal = {kind: "user", mentraUserId: "mu_admin", tenantId: "mentra", email: "admin@example.test", emailVerified: true, isOrganizationAdmin: true, via: "bearer"}
const member: CorePrincipal = {...admin, mentraUserId: "mu_member", email: "member@example.test", isOrganizationAdmin: false}
const operatorKey = (scopes: string[]): CorePrincipal => ({
  kind: "credential",
  credentialId: "cred_sales",
  credentialKind: "organization",
  workspaceId: null,
  scopes,
  packageNames: [],
  label: "Sales tooling",
  createdByEmail: "admin@example.test",
})
const workspaceKey: CorePrincipal = {
  kind: "credential",
  credentialId: "cred_ws",
  credentialKind: "workspace",
  workspaceId: WS,
  scopes: ["miniapps.publish"],
  packageNames: [],
  label: "Publishing",
}

/** The organization API as Core mounts it, with `principal` already authenticated. */
function app(principal: CorePrincipal) {
  const root = new Hono<AppEnv>()
  root.use("*", async (c, next) => {
    c.set("principal", principal)
    c.set("reqId", "grant-test")
    await next()
  })
  root.onError((error, c) => {
    if (error instanceof OauthError) return c.json({error: error.code, error_description: error.description}, error.httpStatus as 400)
    if (error instanceof WorkspaceError) return c.json({error: error.code}, error.status as 400)
    return c.json({error: error.message}, 500)
  })
  return root.route("/api/organization", createOrganizationApi())
}

const endsAt = () => new Date(Date.now() + 365 * DAY).toISOString()
const body = (overrides: Record<string, unknown> = {}) => ({product: "mentra.call.unlimited", seats: 2, endsAt: endsAt(), note: "Reseller pilot", ...overrides})
const post = (principal: CorePrincipal, payload: unknown = body(), key: string | null = "grant-2026-11-17") =>
  app(principal).request(PATH, {
    method: "POST",
    headers: {authorization: "Bearer test", "content-type": "application/json", ...(key === null ? {} : {"idempotency-key": key})},
    body: JSON.stringify(payload),
  })

/** What billing received: the method, the path, the verified principal, and the body as text and as JSON (`{}` for none). */
interface Forwarded {
  method: string
  path: string
  principal: ReturnType<typeof verifyForwardedPrincipal>
  text: string
  body: Record<string, unknown>
}

/** Billing on the network: records each request it is forwarded and answers `answer(request)`. */
function billing(answer: (request: Forwarded) => Response): Forwarded[] {
  const received: Forwarded[] = []
  spy(
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init)
      const url = new URL(request.url)
      const text = await request.text()
      const principal = verifyForwardedPrincipal({method: request.method, pathWithQuery: url.pathname + url.search, body: text, headers: request.headers}, [SECRET])
      const forwarded = {method: request.method, path: url.pathname, principal, text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown>}
      received.push(forwarded)
      return answer(forwarded)
    }) as typeof fetch),
  )
  return received
}

const granted = (overrides: Partial<LicenseGrant> = {}): LicenseGrant => ({
  workspaceId: WS,
  product: "mentra.call.unlimited",
  seats: 2,
  endsAt: "2027-11-17T00:00:00Z",
  status: "trialing",
  subscriptionId: "sub_granted",
  licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD",
  replayed: false,
  ...overrides,
})

let audit: ReturnType<typeof spyOn>
let workspace: ReturnType<typeof spyOn>

beforeEach(() => {
  process.env.CLOUD_CORE_BILLING_URL = "https://billing.test/billing"
  process.env.CLOUD_CORE_BILLING_SECRET = SECRET
  workspace = spy(spyOn(workspaces, "getWorkspace").mockResolvedValue({workspaceId: WS, name: "Target", status: "active", authorizationRevision: 1}))
  audit = spy(spyOn(AdminActionAuditLogModel, "create").mockResolvedValue({} as never))
})

afterEach(() => {
  for (const made of spies.splice(0)) made.mockRestore()
  for (const key of ["CLOUD_CORE_BILLING_URL", "CLOUD_CORE_BILLING_SECRET"]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("who may grant", () => {
  test("a person who is not an Organization Admin, a workspace key and an operator key without the capability are refused", async () => {
    const received = billing(() => Response.json(granted(), {status: 201}))
    for (const principal of [member, operatorKey(["organization.incidents.read"])]) {
      const response = await post(principal)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({error: "forbidden", error_description: "organization.licenses.grant is required"})
    }
    // A workspace's key is no organization's caller at all.
    const byWorkspaceKey = await post(workspaceKey)
    expect(byWorkspaceKey.status).toBe(403)
    expect(await byWorkspaceKey.json()).toEqual({error: "forbidden", error_description: "a signed-in person or an operator key is required"})
    expect(received).toHaveLength(0)
    expect(workspace).not.toHaveBeenCalled()
  })

  test("an Organization Admin's grant reaches billing as the person, scoped to the workspace, with the request as Core checked it", async () => {
    const received = billing(() => Response.json(granted(), {status: 201}))
    const year = new Date().getUTCFullYear() + 1
    const response = await post(admin, body({endsAt: `${year}-06-15T01:00:00.500+01:00`, note: "  Reseller pilot  ", idempotencyKey: "from-the-body"}))
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(granted())
    expect(received).toHaveLength(1)
    const [forwarded] = received
    expect(forwarded!.path).toBe(`/billing/v1/portal/workspaces/${WS}/license-grants`)
    expect(forwarded!.principal).toEqual({
      kind: "user",
      mentraUserId: "mu_admin",
      email: "admin@example.test",
      emailVerified: true,
      isOrganizationAdmin: true,
      organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
      scope: {kind: "workspace", workspaceId: WS},
    })
    // The header is the key; the body's is not read. The end is in UTC whole seconds and the note trimmed.
    expect(forwarded!.body).toEqual({product: "mentra.call.unlimited", seats: 2, endsAt: `${year}-06-15T00:00:00Z`, note: "Reseller pilot", idempotencyKey: "grant-2026-11-17"})
    expect(audit).toHaveBeenCalledWith({
      adminId: "admin@example.test",
      action: "workspace.licenses.granted",
      targetType: "workspace",
      targetId: WS,
      reason: "Reseller pilot",
      metadata: {product: "mentra.call.unlimited", seats: 2, endsAt: "2027-11-17T00:00:00Z", subscriptionId: "sub_granted", licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD", replayed: false},
    })
  })

  test("an operator key that carries the capability reaches billing as the key and its creator, never as a person", async () => {
    const received = billing(() => Response.json(granted({replayed: true}), {status: 200}))
    const response = await post(operatorKey(["organization.incidents.read", "organization.licenses.grant"]))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(granted({replayed: true}))
    expect(received[0]!.principal).toEqual({
      kind: "credential",
      credentialId: "cred_sales",
      label: "Sales tooling",
      createdByEmail: "admin@example.test",
      organizationCapabilities: ["organization.incidents.read", "organization.licenses.grant"],
      scope: {kind: "workspace", workspaceId: WS},
    })
    // The admin log names the key as every key's act is named: its ID, its name and its creator.
    expect(audit.mock.calls[0]![0]).toMatchObject({
      adminId: "credential:cred_sales (Sales tooling, created by admin@example.test)",
      metadata: {replayed: true},
    })
  })
})

describe("what Core checks before billing hears of it", () => {
  test("a request it refuses never reaches billing: each says why", async () => {
    const received = billing(() => Response.json(granted(), {status: 201}))
    const cases: Array<[unknown, string | null, string]> = [
      [body(), null, "an Idempotency-Key header of 1 to 200 visible ASCII characters is required"],
      [body(), "two words", "an Idempotency-Key header of 1 to 200 visible ASCII characters is required"],
      [body({seats: 0}), "k", "seats must be a whole number from 1 to 1000"],
      [body({seats: 1001}), "k", "seats must be a whole number from 1 to 1000"],
      [body({seats: 2.5}), "k", "seats must be a whole number from 1 to 1000"],
      [body({endsAt: new Date(Date.now() + 731 * DAY).toISOString()}), "k", "endsAt must be at most 730 days from now"],
      [body({endsAt: "2027-02-30"}), "k", "endsAt must be an RFC 3339 date-time with its offset (2027-11-17T00:00:00Z) or a date (2027-11-17)"],
      [body({product: undefined}), "k", "product must be a product key, such as mentra.call.unlimited"],
      [body({note: "x".repeat(501)}), "k", "note must be at most 500 characters"],
      [[body()], "k", "request body must be a JSON object"],
    ]
    for (const [payload, key, description] of cases) {
      const response = await post(admin, payload, key)
      expect({status: response.status, body: await response.json()}).toEqual({status: 400, body: {error: "invalid_request", error_description: description}})
    }
    expect(received).toHaveLength(0)
  })

  test("an end that is past or under an hour away reaches billing, which answers a repeat of the key with its grant", async () => {
    const received = billing(() => Response.json(granted({replayed: true}), {status: 200}))
    for (const ends of [new Date(Date.now() - DAY), new Date(Date.now() + 10 * 60_000)]) {
      const response = await post(admin, body({endsAt: ends.toISOString()}))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(granted({replayed: true}))
    }
    expect(received.map((forwarded) => forwarded.body.endsAt)).toHaveLength(2)
  })

  test("a workspace that is deleted or unknown is 404", async () => {
    const received = billing(() => Response.json(granted(), {status: 201}))
    workspace.mockResolvedValueOnce({workspaceId: WS, name: "Target", status: "deleted", authorizationRevision: 2})
    expect((await post(admin)).status).toBe(404)
    workspace.mockResolvedValueOnce(null)
    const response = await post(admin)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({error: "workspace_not_found"})
    expect(received).toHaveLength(0)
  })

  test("a Core without billing answers 503 billing_unavailable", async () => {
    delete process.env.CLOUD_CORE_BILLING_URL
    const response = await post(admin)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({error: "billing_unavailable"})
  })
})

describe("billing's answer", () => {
  test("a refusal reaches the caller as billing gave it, and records nothing", async () => {
    billing(() => Response.json({error: "already_licensed", licenseId: "01LICENSE", error_description: "the workspace already holds this product"}, {status: 409}))
    const response = await post(admin)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({error: "already_licensed", licenseId: "01LICENSE", error_description: "the workspace already holds this product"})
    expect(audit).not.toHaveBeenCalled()
  })

  test("an answer that is not a grant of this workspace, or billing failing, is 503 and records nothing", async () => {
    let answer: Response = Response.json({...granted(), workspaceId: "ws_other"}, {status: 201})
    billing(() => answer)
    expect((await post(admin)).status).toBe(503)
    answer = Response.json({ok: true}, {status: 201})
    expect((await post(admin)).status).toBe(503)
    answer = Response.json({error: "billing_unavailable"}, {status: 503})
    const failed = await post(admin)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({error: "billing_unavailable"})
    expect(audit).not.toHaveBeenCalled()
  })

  test("a grant made is answered even when its admin log record fails", async () => {
    billing(() => Response.json(granted(), {status: 201}))
    audit.mockRejectedValueOnce(new Error("database down"))
    const response = await post(admin)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(granted())
  })
})

describe("ending a grant early", () => {
  const CALL = "mentra.call.unlimited"
  const END_PATH = `${PATH}/${CALL}/end`
  const ended = (overrides: Partial<LicenseGrantEnded> = {}): LicenseGrantEnded => ({
    workspaceId: WS,
    product: CALL,
    subscriptionId: "sub_granted",
    licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD",
    endedAt: "2026-11-26T12:00:00Z",
    ...overrides,
  })
  /** The request as a caller sends it: `payload` as its JSON body, a string as the body itself, or none at all. */
  const end = (principal: CorePrincipal, payload?: unknown, path = END_PATH) =>
    app(principal).request(path, {
      method: "POST",
      headers: {authorization: "Bearer test", ...(payload === undefined ? {} : {"content-type": "application/json"})},
      ...(payload === undefined ? {} : {body: typeof payload === "string" ? payload : JSON.stringify(payload)}),
    })

  test("a person who is not an Organization Admin, a workspace key and an operator key without the capability are refused", async () => {
    const received = billing(() => Response.json(ended()))
    for (const principal of [member, operatorKey(["organization.licenses.read"])]) {
      const response = await end(principal)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({error: "forbidden", error_description: "organization.licenses.grant is required"})
    }
    const byWorkspaceKey = await end(workspaceKey)
    expect(byWorkspaceKey.status).toBe(403)
    expect(await byWorkspaceKey.json()).toEqual({error: "forbidden", error_description: "a signed-in person or an operator key is required"})
    expect(received).toHaveLength(0)
    expect(workspace).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  test("an Organization Admin's request reaches billing as the person, scoped to the workspace, with no body; the note stays in Core's record", async () => {
    const received = billing(() => Response.json(ended()))
    const response = await end(admin, {note: "  Sold through another reseller  ", product: "mentra.other", subscriptionId: "sub_other"})
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ended())
    expect(received).toHaveLength(1)
    const [forwarded] = received
    expect(forwarded!.method).toBe("POST")
    expect(forwarded!.path).toBe(`/billing/v1/portal/workspaces/${WS}/license-grants/${CALL}/end`)
    expect(forwarded!.text).toBe("")
    expect(forwarded!.principal).toEqual({
      kind: "user",
      mentraUserId: "mu_admin",
      email: "admin@example.test",
      emailVerified: true,
      isOrganizationAdmin: true,
      organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
      scope: {kind: "workspace", workspaceId: WS},
    })
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith({
      adminId: "admin@example.test",
      action: "workspace.licenses.grant_ended",
      targetType: "workspace",
      targetId: WS,
      reason: "Sold through another reseller",
      metadata: {product: CALL, subscriptionId: "sub_granted", licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD", endedAt: "2026-11-26T12:00:00Z"},
    })
  })

  test("an operator key that carries the capability reaches billing as the key; a request with no body has no note", async () => {
    const received = billing(() => Response.json(ended({licenseId: null})))
    for (const payload of [undefined, "", {}, {note: "   "}, {note: null}]) {
      const response = await end(operatorKey(["organization.licenses.grant"]), payload)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(ended({licenseId: null}))
    }
    expect(received).toHaveLength(5)
    expect(received[0]!.principal).toEqual({
      kind: "credential",
      credentialId: "cred_sales",
      label: "Sales tooling",
      createdByEmail: "admin@example.test",
      organizationCapabilities: ["organization.licenses.grant"],
      scope: {kind: "workspace", workspaceId: WS},
    })
    for (const [record] of audit.mock.calls) {
      expect(record).toMatchObject({
        adminId: "credential:cred_sales (Sales tooling, created by admin@example.test)",
        action: "workspace.licenses.grant_ended",
        reason: null,
        metadata: {licenseId: null},
      })
    }
  })

  test("a request Core refuses never reaches billing: each says why", async () => {
    const received = billing(() => Response.json(ended()))
    const product = "product must be a product key, such as mentra.call.unlimited"
    const cases: Array<[string, unknown, string]> = [
      [`${PATH}/Mentra%20Call/end`, {}, product],
      [`${PATH}/.hidden/end`, {}, product],
      [`${PATH}/${"m".repeat(101)}/end`, {}, product],
      [END_PATH, {note: "x".repeat(501)}, "note must be at most 500 characters"],
      [END_PATH, {note: 5}, "note must be a string"],
      [END_PATH, [{note: "in a list"}], "request body must be a JSON object"],
      [END_PATH, "not json", "request body must be a JSON object"],
    ]
    for (const [path, payload, description] of cases) {
      const response = await end(admin, payload, path)
      expect({status: response.status, body: await response.json()}).toEqual({status: 400, body: {error: "invalid_request", error_description: description}})
    }
    expect(received).toHaveLength(0)
    expect(audit).not.toHaveBeenCalled()
  })

  test("the product reaches billing as Core checked it, however the path spelled it", async () => {
    const received = billing(() => Response.json(ended()))
    expect((await end(admin, undefined, `${PATH}/%6dentra.call.unlimited/end`)).status).toBe(200)
    expect(received[0]!.path).toBe(`/billing/v1/portal/workspaces/${WS}/license-grants/${CALL}/end`)
  })

  test("a workspace that is deleted or unknown is 404, and a Core without billing 503", async () => {
    const received = billing(() => Response.json(ended()))
    workspace.mockResolvedValueOnce({workspaceId: WS, name: "Target", status: "deleted", authorizationRevision: 2})
    expect((await end(admin)).status).toBe(404)
    workspace.mockResolvedValueOnce(null)
    const unknown = await end(admin)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({error: "workspace_not_found"})
    delete process.env.CLOUD_CORE_BILLING_URL
    const response = await end(admin)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({error: "billing_unavailable"})
    expect(received).toHaveLength(0)
    expect(audit).not.toHaveBeenCalled()
  })

  test("billing's refusals reach the caller as billing gave them, and record nothing", async () => {
    const refusals: Array<[number, Record<string, string>]> = [
      [404, {error: "grant_not_found", error_description: "the workspace has no grant of this product running"}],
      [409, {error: "not_a_grant", error_description: "the workspace's license of this product is not a grant"}],
      [409, {error: "grant_renewed", error_description: "the workspace renewed this grant"}],
      [409, {error: "checkout_in_progress", error_description: "try again in a minute"}],
      [404, {error: "workspace_not_found"}],
    ]
    let answer: Response = Response.json({})
    billing(() => answer)
    for (const [status, refusal] of refusals) {
      answer = Response.json(refusal, {status})
      const response = await end(admin, {note: "Ended at the customer's request"})
      expect({status: response.status, body: await response.json()}).toEqual({status, body: refusal})
    }
    expect(audit).not.toHaveBeenCalled()
  })

  test("an answer that is not this workspace's grant of this product ended, or billing failing, is 503 and records nothing", async () => {
    let answer: Response = Response.json(ended({workspaceId: "ws_other"}))
    billing(() => answer)
    expect((await end(admin)).status).toBe(503)
    answer = Response.json(ended({product: "mentra.other"}))
    expect((await end(admin)).status).toBe(503)
    answer = Response.json({ok: true})
    const unconfirmed = await end(admin)
    expect(unconfirmed.status).toBe(503)
    expect(await unconfirmed.json()).toEqual({
      error: "billing_unavailable",
      error_description: "billing did not confirm that the grant ended; ask again: grant_not_found then means it had",
    })
    answer = Response.json({error: "billing_unavailable"}, {status: 503})
    const failed = await end(admin)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({error: "billing_unavailable"})
    expect(audit).not.toHaveBeenCalled()
  })

  test("a grant ended is answered even when its admin log record fails", async () => {
    billing(() => Response.json(ended()))
    audit.mockRejectedValueOnce(new Error("database down"))
    const response = await end(admin)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ended())
  })
})
