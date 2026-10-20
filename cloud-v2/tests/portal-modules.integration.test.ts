/**
 * @fileoverview Portal module forwarding through the real Core app (`createApp`), against a fake billing module.
 *
 * Core hosts the Mentra Miniapp Store's billing module the way it hosts Fleet: the workspace portal's
 * `/api/portal/billing/*` is forwarded to the module with two HMACs and a signed principal. The fake module
 * here is a `Bun.serve` on loopback that does what the real one does: it verifies every request with the
 * contract's `verifyForwardedPrincipal` and answers with the principal it verified. Everything on Core's side is
 * real: the portal session, the principal middleware, the workspace models and memberships on a local replica
 * set, and the keys.
 *
 * What it pins: a member reaches `/v1/portal/workspaces/:id/*` with their workspace as the scope and an
 * Organization Admin with any; a non-member is refused with no call; `/account/*` is always the person's own
 * scope, whatever the request asks; a workspace key or an operator key never reaches the module; an upstream 401 is
 * a 403; `ui/entry.js` is relayed under Core's security headers and html is refused; `GET /api/portal/me` reports
 * `modules.billing`; and on a Core that is not prod, billing is staff-only: 404 and no call for anyone who is not an
 * Organization Admin.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The database
 * is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/portal-modules.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {EnterpriseOrgModel} from "../packages/core/src/models/enterprise-org.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {ORGANIZATION_CAPABILITIES} from "../packages/workspace-contract/src/index"
import {verifyForwardedPrincipal} from "../packages/workspace-contract/src/server"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  coreAccessToken,
  HOSTED_ENV,
  PORTAL_COOKIE,
  PORTAL_ORIGIN,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const SECRET = "portal-modules-integration-secret"

const MODELS = [
  AccessCredentialModel,
  BrowserSessionModel,
  EnterpriseOrgModel,
  SigninIdentityModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
] as const

/** Hosted Core with a fake Supabase project; `ADMIN_EMAIL` is the only Organization Admin. */
const TEST_ENV: Record<string, string | undefined> = {
  ...HOSTED_ENV,
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
  CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
  CLOUD_CORE_ENVIRONMENT: "prod",
  CLOUD_CORE_ENABLED_FEATURES: undefined,
  CONSOLE2_URL: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
  CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: "https://core.example.test/invite/{token}",
  RESEND_API_KEY: undefined,
  REFRESH_TOKEN_PEPPER: "portal-modules-test-pepper",
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

// --- The fake billing module -------------------------------------------------

interface Received {
  method: string
  /** The request target as it arrived on the wire: path and query, no origin. */
  pathWithQuery: string
  body: string
  headers: Headers
}

/** What the fake module answers when it verified the request. */
interface Echo {
  principal: unknown
  method: string
  pathWithQuery: string
  body: string
  requestId: string | null
}

let received: Received[] = []
/** Changes a request after Core sent it and before the fake module verifies it. */
let tamper: ((request: Received) => Received) | null = null
/** Answers in place of the fake module's own, once it has recorded the request. */
let answer: (() => Response) | null = null

const billingModule = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const origin = new URL(request.url).origin
    const got: Received = {
      method: request.method,
      pathWithQuery: request.url.slice(origin.length),
      body: await request.text(),
      headers: request.headers,
    }
    received.push(got)
    if (answer) return answer()
    const checked = tamper ? tamper(got) : got
    const principal = verifyForwardedPrincipal(
      {method: checked.method, pathWithQuery: checked.pathWithQuery, body: checked.body, headers: checked.headers},
      [SECRET],
    )
    if (!principal) return Response.json({error: "fake_module_unverified"}, {status: 403})
    if (got.pathWithQuery.startsWith("/v1/portal/ui/")) {
      return new Response("export default {contractVersion: 1}", {headers: {"content-type": "text/javascript; charset=utf-8"}})
    }
    const echo: Echo = {
      principal,
      method: got.method,
      pathWithQuery: got.pathWithQuery,
      body: got.body,
      requestId: got.headers.get("x-request-id"),
    }
    return Response.json(echo, {headers: {"x-request-id": got.headers.get("x-request-id") ?? ""}})
  },
})

// --- Fixtures ----------------------------------------------------------------

interface Person {
  sub: string
  email: string
  mentraUserId: string
  /** A Core access token from Core's sign-in server, for `Authorization: Bearer`. */
  bearer: string
  /** The person's workspace portal session, as a `Cookie` header value. */
  cookie: string
}

/** A person with a Mentra account at the fake identity provider, a Core user and a workspace portal session. */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const sub = `supa-${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  idp.registerUser({sub, email, emailConfirmed: emailVerified})
  const bearer = await coreAccessToken({sub, email, emailVerified})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  const {cookieValue} = await createPortalSession("portal", {
    mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: sub,
    email,
    emailVerified,
    authTime: new Date(),
  })
  return {sub, email, mentraUserId, bearer, cookie: `${PORTAL_COOKIE}=${cookieValue}`}
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

async function send(
  method: string,
  path: string,
  opts: {headers?: Record<string, string>; body?: string | Uint8Array} = {},
): Promise<Reply> {
  const response = await app.request(`${PORTAL_ORIGIN}${path}`, {method, headers: opts.headers, body: opts.body})
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, headers: response.headers, json, text}
}

/** A request to `/api/portal<rest>` by a person's portal session cookie, or their bearer when `via` is "bearer". */
function fromPerson(
  who: Person,
  method: string,
  rest: string,
  opts: {via?: "session" | "bearer"; headers?: Record<string, string>; body?: string} = {},
) {
  const {via, ...request} = opts
  const headers: Record<string, string> = {...opts.headers}
  if (via === "bearer") headers.authorization = `Bearer ${who.bearer}`
  else {
    headers.cookie = who.cookie
    if (method !== "GET" && method !== "HEAD") headers.origin ??= PORTAL_ORIGIN
  }
  return send(method, `/api/portal${rest}`, {...request, headers})
}

const billing = (who: Person, method: string, rest: string, opts: Parameters<typeof fromPerson>[3] = {}) =>
  fromPerson(who, method, `/billing${rest}`, opts)

/** A workspace the person creates through the portal; they are its owner, so a member. */
async function workspaceOf(owner: Person, name: string): Promise<string> {
  const created = await fromPerson(owner, "POST", "/workspaces", {
    body: JSON.stringify({name}),
    headers: {"content-type": "application/json"},
  })
  expect(created.status).toBe(201)
  return created.json.workspaceId
}

/** An operator key (`mak_`) created through the admin portal by an Organization Admin. */
async function operatorKey(scopes: readonly string[]): Promise<string> {
  const { cookieValue } = await createPortalSession("admin", {
    mentraUserId: (await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-key-creator"})).mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: "supa-key-creator",
    email: ADMIN_EMAIL,
    emailVerified: true,
    authTime: new Date(),
  })
  const created = await send("POST", "/api/admin/organization/credentials", {
    headers: {cookie: `${ADMIN_COOKIE}=${cookieValue}`, origin: ADMIN_ORIGIN, "content-type": "application/json"},
    body: JSON.stringify({name: "ops", scopes}),
  })
  expect(created.status).toBe(201)
  return created.json.token
}

/** A workspace key (`msk_`) for a workspace the owner created. */
async function workspaceKey(owner: Person, workspaceId: string): Promise<string> {
  const credential = await send("POST", `/api/workspaces/${workspaceId}/credentials`, {
    headers: {authorization: `Bearer ${owner.bearer}`, "content-type": "application/json"},
    body: JSON.stringify({name: "ci", packageNames: ["com.acme.app"]}),
  })
  expect(credential.status).toBe(201)
  return credential.json.token
}

/** Core with `environment` as its environment and the fake module installed. */
function useBilling(environment: string | undefined = "prod") {
  restoreEnv()
  restoreEnv = applyEnv({
    ...TEST_ENV,
    CLOUD_CORE_ENVIRONMENT: environment,
    CLOUD_CORE_BILLING_URL: `http://127.0.0.1:${billingModule.port}`,
    CLOUD_CORE_BILLING_SECRET: SECRET,
  })
  resetCoreKeyCaches()
}

// --- Lifecycle ---------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("portal-modules")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another test file would silently win.
  // Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  // Startup migrations do not run here; the transactions need their collections and indexes.
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  billingModule.stop(true)
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({...TEST_ENV, CLOUD_CORE_BILLING_URL: undefined, CLOUD_CORE_BILLING_SECRET: undefined})
  // Core's signing keys are read from the environment on first use; other suites in this process set their own.
  resetCoreKeyCaches()
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  resetIdpTokenCaches()
  received = []
  tamper = null
  answer = null
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
  app = createApp({readinessChecks: []})
})

afterEach(() => {
  idp.restore()
  restoreEnv()
  resetCoreKeyCaches()
})

// --- Tests -------------------------------------------------------------------

describe("a module that is not installed", () => {
  test("is a 404 module_not_installed after authentication, and an unauthenticated request is still a 401", async () => {
    const someone = await person("someone")

    for (const rest of ["/account/licenses", "/workspaces/ws_1/licenses", "/ui/entry.js"]) {
      const reply = await billing(someone, "GET", rest)
      expect([rest, reply.status, reply.json]).toEqual([rest, 404, {error: "module_not_installed"}])
      const anonymous = await send("GET", `/api/portal/billing${rest}`)
      expect([rest, anonymous.status]).toEqual([rest, 401])
    }
    expect(received).toHaveLength(0)
  })

  test("with settings Core cannot use, is a 503 module_unavailable for a person who may see it", async () => {
    useBilling("prod")
    process.env.CLOUD_CORE_BILLING_URL = "ftp://store.example.test"
    const someone = await person("someone")

    const reply = await billing(someone, "GET", "/account/licenses")

    expect([reply.status, reply.json]).toEqual([503, {error: "module_unavailable"}])
    expect(received).toHaveLength(0)
  })
})

describe("workspace routes", () => {
  test("a member reaches the module with their workspace as the scope; the signed request is the one that was sent", async () => {
    useBilling("prod")
    const owner = await person("owner")
    const workspaceId = await workspaceOf(owner, "Acme")

    const reply = await billing(owner, "POST", `/workspaces/${workspaceId}/licenses?x=1`, {
      body: '{"seats":3}',
      headers: {"content-type": "application/json"},
    })

    expect(reply.status).toBe(200)
    const echo = reply.json as Echo
    expect(echo.pathWithQuery).toBe(`/v1/portal/workspaces/${workspaceId}/licenses?x=1`)
    expect(echo.body).toBe('{"seats":3}')
    expect(echo.principal).toEqual({
      kind: "user",
      mentraUserId: owner.mentraUserId,
      email: owner.email,
      emailVerified: true,
      isOrganizationAdmin: false,
      organizationCapabilities: [],
      scope: {kind: "workspace", workspaceId},
    })
  })

  test("an Organization Admin gets a workspace scope for a workspace they are not in", async () => {
    useBilling("prod")
    const owner = await person("owner")
    const workspaceId = await workspaceOf(owner, "Acme")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await billing(admin, "GET", `/workspaces/${workspaceId}/licenses`)

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toEqual({
      kind: "user",
      mentraUserId: admin.mentraUserId,
      email: ADMIN_EMAIL,
      emailVerified: true,
      isOrganizationAdmin: true,
      organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
      scope: {kind: "workspace", workspaceId},
    })
  })

  test("a non-member is a 403 and the module is never called; the same person can still use their own", async () => {
    useBilling("prod")
    const owner = await person("owner")
    const workspaceId = await workspaceOf(owner, "Acme")
    const stranger = await person("stranger")

    for (const method of ["GET", "POST", "DELETE"]) {
      const reply = await billing(stranger, method, `/workspaces/${workspaceId}/licenses`, {body: method === "POST" ? "{}" : undefined})
      expect([method, reply.status, reply.json.error, reply.json.reason]).toEqual([method, 403, "forbidden", "not_a_member"])
    }
    expect(received).toHaveLength(0)

    const own = await workspaceOf(stranger, "Mine")
    expect((await billing(stranger, "GET", `/workspaces/${own}/licenses`)).status).toBe(200)
    expect(received).toHaveLength(1)
  })

  test("an unknown workspace is a 404 workspace_not_found, with no call", async () => {
    useBilling("prod")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await billing(admin, "GET", "/workspaces/ws_unknown/licenses")

    expect([reply.status, reply.json.error]).toEqual([404, "workspace_not_found"])
    expect(received).toHaveLength(0)
  })
})

describe("account routes", () => {
  test("carry the person's own scope, even when the request asks for a workspace's", async () => {
    useBilling("prod")
    const owner = await person("owner")
    const workspaceId = await workspaceOf(owner, "Acme")

    const reply = await billing(owner, "POST", `/account/checkout?scope=workspace&workspaceId=${workspaceId}`, {
      body: JSON.stringify({scope: {kind: "workspace", workspaceId}, workspaceId}),
      headers: {"content-type": "application/json", "x-mentra-scope": "workspace"},
    })

    expect(reply.status).toBe(200)
    const echo = reply.json as Echo
    expect(echo.pathWithQuery).toBe(`/v1/portal/account/checkout?scope=workspace&workspaceId=${workspaceId}`)
    expect(echo.principal).toMatchObject({kind: "user", mentraUserId: owner.mentraUserId, scope: {kind: "person"}})
    // The module is handed the body and query as they were, to ignore.
    expect(echo.body).toContain(workspaceId)
  })

  test("work with a Core access token as well as a portal session", async () => {
    useBilling("prod")
    const someone = await person("someone")

    const reply = await billing(someone, "GET", "/account/licenses", {via: "bearer"})

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toMatchObject({mentraUserId: someone.mentraUserId, scope: {kind: "person"}})
  })

  test("nothing the browser sends reaches the module but the content type and the accept header", async () => {
    useBilling("prod")
    const someone = await person("someone")

    await billing(someone, "POST", "/account/checkout", {
      body: "{}",
      headers: {"content-type": "application/json", accept: "application/json", "x-mentra-principal": "forged", "x-mentra-user-id": "mu_x"},
    })

    const names = [...received[0].headers.keys()].filter(name => name.startsWith("x-mentra-")).sort()
    expect(names).toEqual([
      "x-mentra-principal",
      "x-mentra-principal-signature",
      "x-mentra-service",
      "x-mentra-service-signature",
      "x-mentra-service-timestamp",
    ])
    expect(received[0].headers.get("x-mentra-principal")).not.toBe("forged")
    expect(received[0].headers.get("cookie")).toBeNull()
    expect(received[0].headers.get("authorization")).toBeNull()
  })

  test("a request changed after Core signed it is refused by the module", async () => {
    useBilling("prod")
    const someone = await person("someone")
    tamper = request => ({...request, body: request.body + " "})

    const reply = await billing(someone, "POST", "/account/checkout", {body: '{"a":1}'})

    expect([reply.status, reply.json]).toEqual([403, {error: "fake_module_unverified"}])
    expect(received).toHaveLength(1)
  })
})

describe("who may call", () => {
  test("a workspace key and an operator key are 403, and the module is never called", async () => {
    useBilling("prod")
    const owner = await person("owner")
    const workspaceId = await workspaceOf(owner, "Acme")
    const keys = [await workspaceKey(owner, workspaceId), await operatorKey(["organization.testing.read"])]

    for (const key of keys) {
      for (const rest of ["/account/licenses", `/workspaces/${workspaceId}/licenses`, "/ui/entry.js"]) {
        const reply = await send("GET", `/api/portal/billing${rest}`, {headers: {authorization: `Bearer ${key}`}})
        expect([key.slice(0, 3), rest, reply.status]).toEqual([key.slice(0, 3), rest, 403])
      }
    }
    expect(received).toHaveLength(0)
  })

  test("the admin portal's cookie authenticates nothing here", async () => {
    useBilling("prod")
    const { cookieValue } = await createPortalSession("admin", {
      mentraUserId: (await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin-cookie"})).mentraUserId,
      tenantId: "mentra",
      sourceId: "mentra",
      subject: "supa-admin-cookie",
      email: ADMIN_EMAIL,
      emailVerified: true,
      authTime: new Date(),
    })

    const reply = await send("GET", "/api/portal/billing/account/licenses", {headers: {cookie: `${ADMIN_COOKIE}=${cookieValue}`}})

    expect(reply.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  test("a write from another origin with the portal cookie is refused by Core before the module", async () => {
    useBilling("prod")
    const someone = await person("someone")

    const reply = await billing(someone, "POST", "/account/checkout", {body: "{}", headers: {origin: "https://evil.example.test"}})

    expect(reply.status).toBe(403)
    expect(received).toHaveLength(0)
  })
})

describe("what comes back", () => {
  test("an upstream 401 reaches the browser as a 403", async () => {
    useBilling("prod")
    const someone = await person("someone")
    answer = () => Response.json({error: "billing_staff_only"}, {status: 401})

    const reply = await billing(someone, "GET", "/account/licenses")

    expect([reply.status, reply.json]).toEqual([403, {error: "billing_staff_only"}])
  })

  test("a failing module is a 503 module_unavailable", async () => {
    useBilling("prod")
    const someone = await person("someone")
    answer = () => new Response("down", {status: 502})

    const reply = await billing(someone, "GET", "/account/licenses")

    expect([reply.status, reply.json]).toEqual([503, {error: "module_unavailable"}])
  })

  test("a session due for rotation keeps its new cookie on the forwarded answer", async () => {
    useBilling("prod")
    const someone = await person("someone")
    const rotatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000)
    const {cookieValue: old} = await createPortalSession(
      "portal",
      {
        mentraUserId: someone.mentraUserId,
        tenantId: "mentra",
        sourceId: "mentra",
        subject: someone.sub,
        email: someone.email,
        emailVerified: true,
        authTime: new Date(),
      },
      rotatedAt,
    )

    const reply = await send("GET", "/api/portal/billing/account/licenses", {headers: {cookie: `${PORTAL_COOKIE}=${old}`}})

    expect(reply.status).toBe(200)
    const rotated = reply.headers.getSetCookie().filter(line => line.startsWith(`${PORTAL_COOKIE}=`))
    expect(rotated).toHaveLength(1)
    expect(rotated[0]).not.toContain(old)
  })
})

describe("the module's UI", () => {
  test("ui/entry.js is relayed to the portal under Core's security headers, as a verified request", async () => {
    useBilling("prod")
    const someone = await person("someone")

    const get = await billing(someone, "GET", "/ui/entry.js?v=1")
    const head = await billing(someone, "HEAD", "/ui/entry.js?v=1")

    expect(get.status).toBe(200)
    expect(get.text).toBe("export default {contractVersion: 1}")
    expect(get.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(get.headers.get("x-content-type-options")).toBe("nosniff")
    expect(get.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(get.headers.get("content-length")).toBe(String(get.text.length))
    expect(get.headers.get("content-security-policy")).toBeNull()
    expect(head.status).toBe(200)
    expect(head.text).toBe("")
    // The fake module answers 403 for anything whose signatures do not verify, so a 200 is a verified request.
    expect(received[0].pathWithQuery).toBe("/v1/portal/ui/entry.js?v=1")
  })

  test("html from the module is a 503, never relayed", async () => {
    useBilling("prod")
    const someone = await person("someone")
    answer = () => new Response("<script>alert(1)</script>", {headers: {"content-type": "text/html"}})

    const reply = await billing(someone, "GET", "/ui/entry.js")

    expect([reply.status, reply.json]).toEqual([503, {error: "module_unavailable"}])
    expect(reply.text).not.toContain("alert")
  })

  test("only GET and HEAD", async () => {
    useBilling("prod")
    const someone = await person("someone")

    const reply = await billing(someone, "POST", "/ui/entry.js", {body: "{}"})

    expect([reply.status, reply.headers.get("allow")]).toEqual([405, "GET, HEAD"])
    expect(received).toHaveLength(0)
  })
})

describe("GET /api/portal/me", () => {
  test("reports modules.billing: false while billing is not installed", async () => {
    const someone = await person("someone")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const who of [someone, admin]) {
      const reply = await fromPerson(who, "GET", "/me")
      expect([reply.status, reply.json.modules]).toEqual([200, {billing: false}])
    }
  })

  test("reports it true when billing is installed and visible to this person", async () => {
    useBilling("prod")
    const someone = await person("someone")

    const reply = await fromPerson(someone, "GET", "/me")

    expect(reply.status).toBe(200)
    expect(reply.json.modules).toEqual({billing: true})
    expect(reply.json.user.id).toBe(someone.mentraUserId)
  })

  test("reports it false when billing is installed but cannot be reached with these settings", async () => {
    useBilling("prod")
    process.env.CLOUD_CORE_BILLING_SECRET = ""
    const someone = await person("someone")

    expect((await fromPerson(someone, "GET", "/me")).json.modules).toEqual({billing: false})
  })
})

describe("billing is staff-only on a Core that is not prod", () => {
  for (const environment of ["dev", "staging"]) {
    test(`on ${environment}: modules.billing is false and /billing/* is a 404 with no call for anyone who is no Organization Admin`, async () => {
      useBilling(environment)
      const owner = await person("owner")
      const workspaceId = await workspaceOf(owner, "Acme")

      const me = await fromPerson(owner, "GET", "/me")
      expect([me.status, me.json.modules]).toEqual([200, {billing: false}])
      for (const rest of ["/account/licenses", `/workspaces/${workspaceId}/licenses`, "/ui/entry.js"]) {
        for (const method of ["GET", "POST"]) {
          const reply = await billing(owner, method, rest, {body: method === "POST" ? "{}" : undefined})
          expect([environment, rest, method, reply.status, reply.json]).toEqual([
            environment,
            rest,
            method,
            404,
            {error: "module_not_installed"},
          ])
        }
      }
      expect(received).toHaveLength(0)
    })

    test(`on ${environment}: a body over the limit cannot probe for hidden billing: a 404, not a 413`, async () => {
      useBilling(environment)
      const owner = await person("owner")

      const reply = await billing(owner, "POST", "/account/checkout", {body: "x".repeat(1024 * 1024 + 1)})

      expect([environment, reply.status, reply.json]).toEqual([environment, 404, {error: "module_not_installed"}])
      expect(received).toHaveLength(0)
    })

    test(`on ${environment}: an Organization Admin sees it and is forwarded`, async () => {
      useBilling(environment)
      const owner = await person("owner")
      const workspaceId = await workspaceOf(owner, "Acme")
      const admin = await person("org-admin", {email: ADMIN_EMAIL})

      const me = await fromPerson(admin, "GET", "/me")
      expect([me.status, me.json.modules]).toEqual([200, {billing: true}])
      const account = await billing(admin, "GET", "/account/licenses")
      const workspace = await billing(admin, "GET", `/workspaces/${workspaceId}/licenses`)
      const ui = await billing(admin, "GET", "/ui/entry.js")

      expect([account.status, workspace.status, ui.status]).toEqual([200, 200, 200])
      expect((account.json as Echo).principal).toMatchObject({isOrganizationAdmin: true, scope: {kind: "person"}})
      expect(received).toHaveLength(3)
    })
  }

  test("on prod both are forwarded", async () => {
    useBilling("prod")
    const someone = await person("someone")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const who of [someone, admin]) {
      expect([(await fromPerson(who, "GET", "/me")).json.modules]).toEqual([{billing: true}])
      expect((await billing(who, "GET", "/account/licenses")).status).toBe(200)
    }
    expect(received).toHaveLength(2)
  })

  test("an address on the allowlist that the identity provider has not verified is no Organization Admin", async () => {
    useBilling("staging")
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})

    expect((await fromPerson(claimed, "GET", "/me")).json.modules).toEqual({billing: false})
    expect((await billing(claimed, "GET", "/account/licenses")).status).toBe(404)
    expect(received).toHaveLength(0)
  })
})
