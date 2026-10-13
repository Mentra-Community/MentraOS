/**
 * @fileoverview Fleet forwarding through the real Core app (`createApp`), against a fake Fleet.
 *
 * Core forwards a phone's `/api/client/fleet/*` and an Organization Admin's `/api/admin/fleet/*` to the
 * private Fleet service (MFM) with two HMACs and a signed principal. The fake Fleet here is a
 * `Bun.serve` on loopback that does what MFM does: it verifies every request with the contract's
 * `verifyForwardedPrincipal` and answers with the principal it verified, the body bytes and the request
 * id it saw. Everything on Core's side is real: the sign-in middleware, the principal middleware, the
 * models and transactions on a local replica set, and the account lookup (a fake Supabase project
 * answers it; see `support/fake-idp.ts`).
 *
 * What it pins: a phone session reaches `/v1/client` as a phone with the account's verified email (null
 * when unverified) and its body bytes and request id round-trip; an Organization Admin session reaches
 * `/v1/admin` with the organization scope whatever the request asks for; workspace keys, operator keys
 * and people without the Fleet capability never reach Fleet; a phone token is no admin credential and an
 * admin cookie is no phone token; and Core signs the exact bytes it sends, which the fake Fleet shows by
 * refusing a request changed after Core signed it.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The
 * database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/fleet-forwarding.integration.test.ts`
 */

import {createHash} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {RevokedJtiModel} from "../packages/core/src/models/revoked-jti.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {resetPhoneEmailCache} from "../packages/core/src/services/fleet/phone-email"
import {createSession} from "../packages/core/src/services/session.service"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {ORGANIZATION_CAPABILITIES} from "../packages/workspace-contract/src/index"
import {FORWARDED_PRINCIPAL_HEADERS, SERVICE_HEADERS, verifyForwardedPrincipal} from "../packages/workspace-contract/src/server"
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
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const SECRET = "fleet-forwarding-integration-secret"

const MODELS = [
  AccessCredentialModel,
  BrowserSessionModel,
  RefreshTokenModel,
  RevokedJtiModel,
  SigninIdentityModel,
  UserModel,
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
  CLOUD_CORE_ENVIRONMENT: undefined,
  CLOUD_CORE_ENABLED_FEATURES: undefined,
  CLOUD_CORE_FLEET_MAX_BODY_BYTES: undefined,
  CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: undefined,
  CLOUD_CORE_FLEET_TIMEOUT_MS: undefined,
  CONSOLE2_URL: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
  CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: "https://core.example.test/invite/{token}",
  RESEND_API_KEY: undefined,
  REFRESH_TOKEN_PEPPER: "fleet-forwarding-test-pepper",
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

// --- The fake Fleet --------------------------------------------------------

interface Received {
  method: string
  /** The request target as it arrived on the wire: path and query, no origin. */
  pathWithQuery: string
  body: string
  headers: Headers
}

/** What the fake Fleet answers when it verified the request. */
interface Echo {
  principal: unknown
  method: string
  pathWithQuery: string
  body: string
  requestId: string | null
  contentType: string | null
}

let received: Received[] = []
/** Changes a request after Core sent it and before the fake Fleet verifies it. */
let tamper: ((request: Received) => Received) | null = null

const fleet = Bun.serve({
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
    const checked = tamper ? tamper(got) : got
    const principal = verifyForwardedPrincipal(
      {method: checked.method, pathWithQuery: checked.pathWithQuery, body: checked.body, headers: checked.headers},
      [SECRET],
    )
    if (!principal) return Response.json({error: "fake_fleet_unverified"}, {status: 403})
    const echo: Echo = {
      principal,
      method: got.method,
      pathWithQuery: got.pathWithQuery,
      body: got.body,
      requestId: got.headers.get("x-request-id"),
      contentType: got.headers.get("content-type"),
    }
    return Response.json(echo, {headers: {"x-request-id": got.headers.get("x-request-id") ?? ""}})
  },
})

// --- Fixtures --------------------------------------------------------------

interface Person {
  sub: string
  email: string
  mentraUserId: string
  /** A Core access token from Core's sign-in server, for `Authorization: Bearer`. */
  bearer: string
  /** The person's admin portal session, as a `Cookie` header value. */
  cookie: string
}

/** A person with a Mentra account at the fake identity provider, a Core user and an admin portal session. */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const sub = `supa-${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  idp.registerUser({sub, email, emailConfirmed: emailVerified})
  const bearer = await coreAccessToken({sub, email, emailVerified})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  const {cookieValue} = await createPortalSession("admin", {
    mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: sub,
    email,
    emailVerified,
    authTime: new Date(),
  })
  return {sub, email, mentraUserId, bearer, cookie: `${ADMIN_COOKIE}=${cookieValue}`}
}

interface Phone {
  sub: string
  mentraUserId: string
  /** The phone's Core access token, from Core's own token exchange of a Supabase session. */
  token: string
}

/** A phone session for a Mentra account whose email is confirmed unless told otherwise. */
async function phoneSession(key: string, options: {email?: string; emailConfirmed?: boolean} = {}): Promise<Phone> {
  const sub = `supa-phone-${key}`
  idp.registerUser({sub, email: options.email ?? `${key}@phone.example.test`, emailConfirmed: options.emailConfirmed ?? true})
  const subjectToken = await idp.mint({sub, aud: "authenticated", role: "authenticated"})
  const {access_token: token} = await createSession({subjectToken})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  return {sub, mentraUserId, token}
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
  const response = await app.request(`${ADMIN_ORIGIN}${path}`, {method, headers: opts.headers, body: opts.body})
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, headers: response.headers, json, text}
}

/** A request from a phone to `/api/client/fleet<rest>`. */
const fromPhone = (
  phone: Phone | string,
  method: string,
  rest: string,
  opts: {headers?: Record<string, string>; body?: string} = {},
) =>
  send(method, `/api/client/fleet${rest}`, {
    ...opts,
    headers: {authorization: `Bearer ${typeof phone === "string" ? phone : phone.token}`, ...opts.headers},
  })

/** A request to `/api/admin/fleet<rest>` by a person's admin session cookie, or their bearer when `via` is "bearer". */
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
    if (method !== "GET" && method !== "HEAD") headers.origin ??= ADMIN_ORIGIN
  }
  return send(method, `/api/admin/fleet${rest}`, {...request, headers})
}

/** An operator key (`mak_`) created through the admin portal by an Organization Admin. */
async function operatorKey(scopes: readonly string[]): Promise<string> {
  const admin = await person("key-creator", {email: ADMIN_EMAIL})
  const created = await send("POST", "/api/admin/organization/credentials", {
    headers: {cookie: admin.cookie, origin: ADMIN_ORIGIN, "content-type": "application/json"},
    body: JSON.stringify({name: "ops", scopes}),
  })
  expect(created.status).toBe(201)
  return created.json.token
}

/** A workspace key (`msk_`) for a workspace the (non-admin) owner created. */
async function workspaceKey(): Promise<string> {
  const owner = await person("ws-owner")
  const workspace = await fromOwner(owner, "/api/workspaces", {name: "Acme"})
  expect(workspace.status).toBe(201)
  const credential = await fromOwner(owner, `/api/workspaces/${workspace.json.workspaceId}/credentials`, {
    name: "ci",
    packageNames: ["com.acme.app"],
  })
  expect(credential.status).toBe(201)
  return credential.json.token
}

const fromOwner = (owner: Person, path: string, body: unknown) =>
  send("POST", path, {
    headers: {authorization: `Bearer ${owner.bearer}`, "content-type": "application/json"},
    body: JSON.stringify(body),
  })

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("fleet-forwarding")
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
  fleet.stop(true)
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({
    ...TEST_ENV,
    CLOUD_CORE_FLEET_URL: `http://127.0.0.1:${fleet.port}`,
    CLOUD_CORE_FLEET_SECRET: SECRET,
  })
  // Core's signing keys are read from the environment on first use; other suites in this process set their own.
  resetCoreKeyCaches()
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  resetIdpTokenCaches()
  resetPhoneEmailCache()
  received = []
  tamper = null
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

// --- Phones ----------------------------------------------------------------

describe("a phone", () => {
  test("a report round-trips its body bytes and request id, and arrives as a verified phone principal", async () => {
    const phone = await phoneSession("a")
    // Characters a text round trip could damage: non-BMP, line separators, CRLF, tabs, a lone surrogate-looking escape.
    const body = JSON.stringify({
      records: Array.from({length: 40}, (_, i) => ({id: `r${i}`, name: "café ☕ 😀   ", note: "a\r\nb\tc"})),
      padding: "x".repeat(300_000),
    })

    const reply = await fromPhone(phone, "POST", "/report", {
      body,
      headers: {"content-type": "application/json", "x-request-id": "rid-phone-1"},
    })

    expect(reply.status).toBe(200)
    expect(received).toHaveLength(1)
    const echo = reply.json as Echo
    expect(echo.method).toBe("POST")
    expect(echo.pathWithQuery).toBe("/v1/client/report")
    expect(echo.contentType).toBe("application/json")
    expect(echo.body.length).toBe(body.length)
    expect(sha256(echo.body)).toBe(sha256(body))
    expect(echo.principal).toEqual({
      kind: "phone",
      mentraUserId: phone.mentraUserId,
      tenantId: "mentra",
      sessionId: expect.stringMatching(/^sess_/),
      email: "a@phone.example.test",
    })
    // The caller chose the request id; it reached Fleet and came back.
    expect(echo.requestId).toBe("rid-phone-1")
    expect(reply.headers.get("x-request-id")).toBe("rid-phone-1")
  })

  test("a request without an id gets one from Core, and it is the one Fleet saw and the caller gets back", async () => {
    const phone = await phoneSession("b")

    const reply = await fromPhone(phone, "GET", "/status")

    expect(reply.status).toBe(200)
    expect(reply.headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect((reply.json as Echo).requestId).toBe(reply.headers.get("x-request-id"))
  })

  test("the principal's email is null when the account's email is not verified", async () => {
    const phone = await phoneSession("unverified", {emailConfirmed: false})

    const reply = await fromPhone(phone, "POST", "/report", {body: "{}"})

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toEqual({
      kind: "phone",
      mentraUserId: phone.mentraUserId,
      tenantId: "mentra",
      sessionId: expect.stringMatching(/^sess_/),
      email: null,
    })
  })

  test("the account directory is asked once for a phone that reports again soon", async () => {
    const phone = await phoneSession("repeat")
    idp.userLookups.length = 0

    for (let i = 0; i < 3; i++) expect((await fromPhone(phone, "POST", "/report", {body: "{}"})).status).toBe(200)

    expect(idp.userLookups).toEqual([phone.sub])
  })

  test("an account directory that is down costs the email, not the report", async () => {
    const phone = await phoneSession("directory-down")
    idp.outage = true

    const reply = await fromPhone(phone, "POST", "/report", {body: "{}"})

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toMatchObject({kind: "phone", email: null})
  })

  test("nothing the phone sends can change who it is to Fleet", async () => {
    const phone = await phoneSession("c")
    const other = await phoneSession("d")
    const forged = Buffer.from(JSON.stringify({kind: "phone", mentraUserId: other.mentraUserId})).toString("base64url")

    const reply = await fromPhone(phone, "POST", "/report?mentraUserId=" + other.mentraUserId, {
      body: JSON.stringify({mentraUserId: other.mentraUserId}),
      headers: {
        [FORWARDED_PRINCIPAL_HEADERS.principal]: forged,
        [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: "forged",
        [SERVICE_HEADERS.service]: "core",
        [SERVICE_HEADERS.signature]: "forged",
        "x-mentra-user-id": other.mentraUserId,
      },
    })

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toMatchObject({kind: "phone", mentraUserId: phone.mentraUserId})
    // Neither the caller's headers nor its bearer reach Fleet.
    const names = [...received[0].headers.keys()]
    expect(names.filter(name => name.startsWith("x-mentra-")).sort()).toEqual(
      [
        FORWARDED_PRINCIPAL_HEADERS.principal,
        FORWARDED_PRINCIPAL_HEADERS.principalSignature,
        SERVICE_HEADERS.service,
        SERVICE_HEADERS.signature,
        SERVICE_HEADERS.timestamp,
      ].sort(),
    )
    expect(names).not.toContain("authorization")
    expect(names).not.toContain("cookie")
  })

  test("an Organization Admin's session cookie is not a phone token: 401, and Fleet is never called", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const method of ["GET", "POST"]) {
      const reply = await send(method, "/api/client/fleet/report", {
        headers: {cookie: admin.cookie, origin: ADMIN_ORIGIN},
        body: method === "POST" ? "{}" : undefined,
      })
      expect([method, reply.status]).toEqual([method, 401])
      expect(reply.json.error).toBe("unauthorized")
    }
    expect(received).toHaveLength(0)
  })

  test("a Core access token issued for a portal is not a phone token either", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await fromPhone(admin.bearer, "POST", "/report", {body: "{}"})

    expect(reply.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  test("no token, a garbled token and a key are 401", async () => {
    const key = await operatorKey(["organization.testing.read"])

    for (const headers of [{}, {authorization: "Bearer not-a-token"}, {authorization: `Bearer ${key}`}]) {
      const reply = await send("POST", "/api/client/fleet/report", {headers, body: "{}"})
      expect([headers, reply.status]).toEqual([headers, 401])
    }
    expect(received).toHaveLength(0)
  })

  test("a phone that signed out is refused", async () => {
    const phone = await phoneSession("signed-out")
    expect((await fromPhone(phone, "POST", "/report", {body: "{}"})).status).toBe(200)

    const revoked = await send("POST", "/api/client/auth/revoke", {headers: {authorization: `Bearer ${phone.token}`}})
    expect(revoked.status).toBe(200)

    const reply = await fromPhone(phone, "POST", "/report", {body: "{}"})
    expect(reply.status).toBe(401)
    expect(received).toHaveLength(1)
  })
})

// --- Organization Admins ---------------------------------------------------

describe("an Organization Admin", () => {
  test("a cookie session reaches Fleet with the organization scope and every organization capability", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await fromPerson(admin, "GET", "/overview?range=7d&tz=Europe%2FParis")

    expect(reply.status).toBe(200)
    const echo = reply.json as Echo
    expect(echo.pathWithQuery).toBe("/v1/admin/overview?range=7d&tz=Europe%2FParis")
    expect(echo.principal).toEqual({
      kind: "user",
      mentraUserId: admin.mentraUserId,
      email: ADMIN_EMAIL,
      emailVerified: true,
      isOrganizationAdmin: true,
      organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
      scope: {kind: "organization"},
    })
  })

  test("so does a Core access token, and a write from the portal's origin carries its body", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const byBearer = await fromPerson(admin, "GET", "/overview", {via: "bearer"})
    const write = await fromPerson(admin, "PUT", "/settings", {
      body: '{"retentionDays":90}',
      headers: {"content-type": "application/json"},
    })

    expect(byBearer.status).toBe(200)
    expect((byBearer.json as Echo).principal).toMatchObject({kind: "user", scope: {kind: "organization"}})
    expect(write.status).toBe(200)
    expect((write.json as Echo).body).toBe('{"retentionDays":90}')
    expect((write.json as Echo).principal).toMatchObject({kind: "user", scope: {kind: "organization"}})
  })

  test("the scope is the organization however the request asks for another", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await fromPerson(admin, "POST", "/overview?scope=workspace&workspaceId=ws_x", {
      body: JSON.stringify({scope: {kind: "workspace", workspaceId: "ws_x"}}),
      headers: {"content-type": "application/json", "x-mentra-scope": "workspace"},
    })

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toMatchObject({kind: "user", scope: {kind: "organization"}})
    // Fleet is handed the query and body as they were, to ignore.
    expect((reply.json as Echo).pathWithQuery).toBe("/v1/admin/overview?scope=workspace&workspaceId=ws_x")
  })

  test("a write from another origin with the cookie is refused by Core before Fleet", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await fromPerson(admin, "PUT", "/settings", {body: "{}", headers: {origin: "https://evil.example.test"}})

    expect(reply.status).toBe(403)
    expect(received).toHaveLength(0)
  })

  test("an allowlisted address the identity provider has not verified is no Organization Admin", async () => {
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})

    for (const via of ["session", "bearer"] as const) {
      const reply = await fromPerson(claimed, "GET", "/overview", {via})
      expect([via, reply.status]).toEqual([via, 403])
    }
    expect(received).toHaveLength(0)
  })
})

// --- Everyone else ---------------------------------------------------------

describe("everyone else", () => {
  test("a workspace key and an operator key get 403 and never reach Fleet", async () => {
    const keys = [await workspaceKey(), await operatorKey(["organization.testing.read", "organization.incidents.read"])]
    const fetched = spyOn(globalThis, "fetch")

    for (const token of keys) {
      for (const method of ["GET", "POST"]) {
        const reply = await send(method, "/api/admin/fleet/overview", {
          headers: {authorization: `Bearer ${token}`},
          body: method === "POST" ? "{}" : undefined,
        })
        expect([token.slice(0, 4), method, reply.status]).toEqual([token.slice(0, 4), method, 403])
        expect(reply.json.error).toBe("forbidden")
      }
    }

    const toFleet = fetched.mock.calls.filter(([url]) => String(url).includes(`127.0.0.1:${fleet.port}`))
    fetched.mockRestore()
    expect(toFleet).toHaveLength(0)
    expect(received).toHaveLength(0)
  })

  test("a workspace owner who is not an Organization Admin gets 403", async () => {
    const owner = await person("ws-owner")
    const created = await fromOwner(owner, "/api/workspaces", {name: "Acme"})
    expect(created.status).toBe(201)

    for (const via of ["session", "bearer"] as const) {
      const reply = await fromPerson(owner, "GET", "/overview", {via})
      expect([via, reply.status]).toEqual([via, 403])
    }
    expect(received).toHaveLength(0)
  })

  test("a phone's access token is no credential on the admin surface: 401", async () => {
    const phone = await phoneSession("e")

    const reply = await send("GET", "/api/admin/fleet/overview", {headers: {authorization: `Bearer ${phone.token}`}})

    expect(reply.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  test("nobody gets in without credentials, on either surface", async () => {
    for (const [method, path] of [
      ["GET", "/api/admin/fleet/overview"],
      ["POST", "/api/admin/fleet/overview"],
      ["GET", "/api/client/fleet/report"],
      ["POST", "/api/client/fleet/report"],
    ] as const) {
      // The portal's origin, so that an unsafe request gets as far as being asked who it is (CSRF comes first).
      const reply = await send(method, path, {headers: {origin: ADMIN_ORIGIN}, body: method === "POST" ? "{}" : undefined})
      expect([method, path, reply.status]).toEqual([method, path, 401])
    }
    expect(received).toHaveLength(0)
  })

  test("a deployment that did not buy Fleet answers 404 to the signed in and 401 to the rest", async () => {
    const restore = applyEnv({CLOUD_CORE_ENABLED_FEATURES: "call.unlimited"})
    try {
      const admin = await person("org-admin", {email: ADMIN_EMAIL})
      const phone = await phoneSession("f")

      const phoneReply = await fromPhone(phone, "POST", "/report", {body: "{}"})
      const adminReply = await fromPerson(admin, "GET", "/overview")
      const nobody = await send("POST", "/api/client/fleet/report", {body: "{}"})

      expect([phoneReply.status, phoneReply.json]).toEqual([404, {error: "fleet_not_installed"}])
      expect([adminReply.status, adminReply.json]).toEqual([404, {error: "fleet_not_installed"}])
      expect(nobody.status).toBe(401)
      expect(received).toHaveLength(0)
    } finally {
      restore()
    }
  })
})

// --- Signing ---------------------------------------------------------------

describe("what Core signs is what it sends", () => {
  const REQUESTS = [
    "/devices/caf%C3%A9%20x?q=a%20b&r=%E2%98%95",
    "/devices/a+b/c;d=e?x=1&x=2&y=%2F",
    "/devices/it's/(1)/[2]/~!*?q='x'&z=\"y\"",
    "/devices/ü?q=日本",
    "/devices?",
    "/devices//x///y?a=b#fragment",
  ]

  test("every request verifies at the fake Fleet, whatever characters its path and query hold", async () => {
    const phone = await phoneSession("g")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const rest of REQUESTS) {
      const fromPhoneReply = await fromPhone(phone, "POST", rest, {body: '{"n":"é"}'})
      const fromAdminReply = await fromPerson(admin, "POST", rest, {body: '{"n":"é"}'})
      expect([rest, fromPhoneReply.status]).toEqual([rest, 200])
      expect([rest, fromAdminReply.status]).toEqual([rest, 200])
    }
    expect(received).toHaveLength(REQUESTS.length * 2)
  })

  test("a request changed after Core signed it fails at the fake Fleet, so the checks above are not vacuous", async () => {
    const phone = await phoneSession("h")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    // The admin's principal header, for a swap onto the phone's request.
    await fromPerson(admin, "GET", "/overview")
    const adminPrincipal = received[0].headers.get(FORWARDED_PRINCIPAL_HEADERS.principal) ?? ""
    expect(adminPrincipal).not.toBe("")

    const tampers: Record<string, (request: Received) => Received> = {
      "a body with one more byte": request => ({...request, body: `${request.body} `}),
      "a different body": request => ({...request, body: request.body.replace("report", "forged")}),
      "a changed query": request => ({...request, pathWithQuery: `${request.pathWithQuery}&scope=workspace`}),
      "a changed path": request => ({...request, pathWithQuery: request.pathWithQuery.replace("/v1/client", "/v1/admin")}),
      "a changed method": request => ({...request, method: "PUT"}),
      "another request's timestamp": request => {
        const headers = new Headers(request.headers)
        headers.set(SERVICE_HEADERS.timestamp, String(Number(headers.get(SERVICE_HEADERS.timestamp)) + 1))
        return {...request, headers}
      },
      "another person's principal": request => {
        const headers = new Headers(request.headers)
        headers.set(FORWARDED_PRINCIPAL_HEADERS.principal, adminPrincipal)
        return {...request, headers}
      },
      "no principal signature": request => {
        const headers = new Headers(request.headers)
        headers.delete(FORWARDED_PRINCIPAL_HEADERS.principalSignature)
        return {...request, headers}
      },
    }

    const untampered = await fromPhone(phone, "POST", "/report?x=1", {body: '{"report":true}'})
    expect(untampered.status).toBe(200)
    for (const [name, change] of Object.entries(tampers)) {
      tamper = change
      const reply = await fromPhone(phone, "POST", "/report?x=1", {body: '{"report":true}'})
      expect([name, reply.status, reply.json]).toEqual([name, 403, {error: "fake_fleet_unverified"}])
    }
  })

  test("a different secret verifies nothing", async () => {
    const phone = await phoneSession("i")
    const restore = applyEnv({CLOUD_CORE_FLEET_SECRET: "not-the-fleet-secret"})
    try {
      const reply = await fromPhone(phone, "POST", "/report", {body: "{}"})

      expect([reply.status, reply.json]).toEqual([403, {error: "fake_fleet_unverified"}])
    } finally {
      restore()
    }
  })
})
