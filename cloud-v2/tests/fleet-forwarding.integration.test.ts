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
 * admin cookie is no phone token; Fleet's UI module (`/api/admin/fleet/ui/*`) is relayed whole through the
 * same session, behind the same gates, and keeps the session cookie Core rotated; and Core signs the exact
 * bytes it sends, which the fake Fleet shows by refusing a request changed after Core signed it.
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
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {AccountEmailModel} from "../packages/core/src/models/account-email.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {RevokedJtiModel} from "../packages/core/src/models/revoked-jti.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import * as authorization from "../packages/core/src/services/workspaces/authorization.service"
import {createWorkspace, deleteWorkspace, type Actor} from "../packages/core/src/services/workspaces/workspace.service"
import {membershipRow} from "./support/membership-row"
import {ACCOUNT_EMAIL_MAX_AGE_MS} from "../packages/core/src/services/account/account-email.service"
import {otc} from "../packages/core/src/services/account/account.service"
import {resetPhoneEmailCache} from "../packages/core/src/services/fleet/phone-email"
import {createSession} from "../packages/core/src/services/session.service"
import {createPortalSession, SESSION_ROTATE_AFTER_MS} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {sha256Hex} from "../packages/core/src/services/signin/random"
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
  cookieValue,
  HOSTED_ENV,
  PORTAL_COOKIE,
  PORTAL_ORIGIN,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const SECRET = "fleet-forwarding-integration-secret"

const MODELS = [
  AccessCredentialModel,
  AccountCodeModel,
  AccountEmailModel,
  BrowserSessionModel,
  RefreshTokenModel,
  RevokedJtiModel,
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
  CLOUD_CORE_ENVIRONMENT: undefined,
  CLOUD_CORE_ENABLED_FEATURES: undefined,
  CLOUD_CORE_FLEET_MAX_BODY_BYTES: undefined,
  CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: undefined,
  CLOUD_CORE_FLEET_MAX_ASSET_BYTES: undefined,
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
/** Answers in place of the fake Fleet's own, once it has recorded the request. */
let answer: (() => Response) | null = null

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
    if (answer) return answer()
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

/**
 * An admin portal session for `who` that was last rotated more than a day ago, so the first request it makes
 * is the one `principalAuth` rotates. Returns the session's cookie value.
 */
async function staleSession(who: Person): Promise<string> {
  const rotatedAt = new Date(Date.now() - SESSION_ROTATE_AFTER_MS - 60_000)
  const {cookieValue: value} = await createPortalSession(
    "admin",
    {
      mentraUserId: who.mentraUserId,
      tenantId: "mentra",
      sourceId: "mentra",
      subject: who.sub,
      email: who.email,
      emailVerified: true,
      authTime: new Date(),
    },
    rotatedAt,
  )
  return value
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

  test("an hour of reports from one account asks the account directory once, whichever Core process takes them", async () => {
    const phone = await phoneSession("hourly")
    idp.userLookups.length = 0

    // An engine-only phone reports every 15 minutes and a phone in use every 5, so each report in an hour can reach a
    // Core process that has not seen the account within its five minutes: another replica, or one that restarted.
    for (let report = 0; report < 12; report++) {
      resetPhoneEmailCache()
      const reply = await fromPhone(phone, "POST", "/report", {body: "{}"})
      expect(reply.status).toBe(200)
      expect((reply.json as Echo).principal).toMatchObject({kind: "phone", email: "hourly@phone.example.test"})
    }

    expect(idp.userLookups).toEqual([phone.sub])
  })

  test("an email changed in the Mentra App reaches Fleet with the account's next report, after one directory lookup", async () => {
    const phone = await phoneSession("renamed")
    expect(((await fromPhone(phone, "POST", "/report", {body: "{}"})).json as Echo).principal).toMatchObject({
      email: "renamed@phone.example.test",
    })
    // The code the Mentra App's change-email screen sends to the new address.
    const code = await otc.issueEmailCode({
      purpose: "email_change",
      subject: phone.sub,
      ttlSec: 60,
      payload: {newEmail: "new-address@phone.example.test"},
    })

    const confirmed = await send("POST", "/api/account/email/change/confirm", {
      headers: {authorization: `Bearer ${phone.token}`, "content-type": "application/json"},
      body: JSON.stringify({code}),
    })
    expect(confirmed.status).toBe(204)

    // Every Core process reads Core's copy again within five minutes; this is that moment.
    resetPhoneEmailCache()
    idp.userLookups.length = 0
    const reply = await fromPhone(phone, "POST", "/report", {body: "{}"})

    expect((reply.json as Echo).principal).toMatchObject({kind: "phone", email: "new-address@phone.example.test"})
    // The change marked Core's copy for a check, so the address comes from the directory itself, once.
    expect(idp.userLookups).toEqual([phone.sub])
    resetPhoneEmailCache()
    expect(((await fromPhone(phone, "POST", "/report", {body: "{}"})).json as Echo).principal).toMatchObject({
      email: "new-address@phone.example.test",
    })
    expect(idp.userLookups).toEqual([phone.sub])
  })

  test("an account directory that is down when Core's copy is due for a check still lets the email through", async () => {
    const phone = await phoneSession("copy-kept")
    await fromPhone(phone, "POST", "/report", {body: "{}"})
    await AccountEmailModel.updateOne(
      {mentraUserId: phone.mentraUserId},
      {$set: {checkedAt: new Date(Date.now() - ACCOUNT_EMAIL_MAX_AGE_MS)}},
    )
    resetPhoneEmailCache()
    idp.outage = true

    const reply = await fromPhone(phone, "POST", "/report", {body: "{}"})

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toMatchObject({kind: "phone", email: "copy-kept@phone.example.test"})
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

  test("a session due for rotation gets its new cookie on the forwarded answer, and the request still forwards", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const old = await staleSession(admin)
    const oldCookie = `${ADMIN_COOKIE}=${old}`

    const reply = await send("GET", "/api/admin/fleet/overview?range=7d", {headers: {cookie: oldCookie}})

    // Forwarded, as the person who holds the session.
    expect(reply.status).toBe(200)
    expect(received).toHaveLength(1)
    expect((reply.json as Echo).principal).toMatchObject({kind: "user", mentraUserId: admin.mentraUserId, scope: {kind: "organization"}})
    // And the rotated cookie reached the browser: without it the old value dies after the grace period.
    const rotated = cookieValue(reply as unknown as Response, ADMIN_COOKIE) ?? null
    expect(rotated).toBeTruthy()
    expect(rotated).not.toBe(old)
    const row = await BrowserSessionModel.findOne({tokenHash: sha256Hex(rotated!)}).lean()
    expect(row?.previousTokenHash).toBe(sha256Hex(old))
    expect(reply.headers.getSetCookie().filter(line => line.startsWith(`${ADMIN_COOKIE}=`))).toHaveLength(1)

    // The new cookie is the session from now on: it forwards, and it is not rotated again.
    const next = await send("GET", "/api/admin/fleet/overview", {headers: {cookie: `${ADMIN_COOKIE}=${rotated}`}})
    expect(next.status).toBe(200)
    expect(next.headers.getSetCookie()).toEqual([])
  })

  test("so does it on every other answer Fleet can give: a refusal, a rate limit, a failure, an empty answer", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const answers: Record<string, [() => Response, number]> = {
      "Fleet's 403": [() => Response.json({error: "fake_fleet_unverified"}, {status: 403}), 403],
      "Fleet's 401 (relayed as 403)": [() => Response.json({error: "no"}, {status: 401}), 403],
      "a 429": [() => Response.json({error: "slow"}, {status: 429, headers: {"retry-after": "30"}}), 429],
      "a 404": [() => Response.json({error: "nope"}, {status: 404}), 404],
      "a 503 with Retry-After": [() => Response.json({error: "down"}, {status: 503, headers: {"retry-after": "30"}}), 503],
      "a 304": [() => new Response(null, {status: 304}), 304],
      "a 204": [() => new Response(null, {status: 204}), 204],
    }

    for (const [name, [reply, status]] of Object.entries(answers)) {
      answer = reply
      const old = await staleSession(admin)

      const response = await send("PUT", "/api/admin/fleet/settings", {
        headers: {cookie: `${ADMIN_COOKIE}=${old}`, origin: ADMIN_ORIGIN, "content-type": "application/json"},
        body: "{}",
      })

      expect([name, response.status]).toEqual([name, status])
      const rotated = cookieValue(response as unknown as Response, ADMIN_COOKIE)
      expect([name, !!rotated, rotated !== old]).toEqual([name, true, true])
    }
  })

  test("a session that is not due for rotation sets no cookie", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await fromPerson(admin, "GET", "/overview")

    expect(reply.status).toBe(200)
    expect(reply.headers.getSetCookie()).toEqual([])
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

// --- Fleet's UI module -----------------------------------------------------

describe("Fleet's UI module", () => {
  const JS = "text/javascript; charset=utf-8"

  test("an Organization Admin's session fetches it as a verified user, GET and HEAD, with Core's security headers", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const get = await fromPerson(admin, "GET", "/ui/entry.js?v=1")
    const head = await fromPerson(admin, "HEAD", "/ui/entry.js?v=1")

    // The fake Fleet answers 403 for anything whose signatures do not verify, so a 200 is a verified request.
    expect(get.status).toBe(200)
    expect(head.status).toBe(200)
    expect(head.text).toBe("")
    const echo = get.json as Echo
    expect(echo.method).toBe("GET")
    expect(echo.pathWithQuery).toBe("/v1/admin/ui/entry.js?v=1")
    expect(echo.principal).toEqual({
      kind: "user",
      mentraUserId: admin.mentraUserId,
      email: ADMIN_EMAIL,
      emailVerified: true,
      isOrganizationAdmin: true,
      organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
      scope: {kind: "organization"},
    })
    expect(received.map(call => call.method)).toEqual(["GET", "HEAD"])
    for (const reply of [get, head]) {
      expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
      expect(reply.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    }
    // Nothing of the portal session goes to Fleet.
    for (const call of received) {
      expect(call.headers.get("cookie")).toBeNull()
      expect(call.headers.get("authorization")).toBeNull()
    }
  })

  test("a 3 MiB module comes through a session due for rotation intact, and the rotated cookie reaches the browser", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const old = await staleSession(admin)
    const bytes = new Uint8Array(3 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff
    answer = () => new Response(bytes, {headers: {"content-type": JS, "etag": '"entry-v1"', "cache-control": "no-cache"}})

    const response = await app.request(`${ADMIN_ORIGIN}/api/admin/fleet/ui/entry.js`, {headers: {cookie: `${ADMIN_COOKIE}=${old}`}})
    const body = new Uint8Array(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(Buffer.from(body).equals(Buffer.from(bytes))).toBe(true)
    expect(response.headers.get("content-type")).toBe(JS)
    expect(response.headers.get("etag")).toBe('"entry-v1"')
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    const rotated = cookieValue(response, ADMIN_COOKIE)
    expect(rotated).toBeTruthy()
    expect(rotated).not.toBe(old)
    expect(response.headers.getSetCookie().filter(line => line.startsWith(`${ADMIN_COOKIE}=`))).toHaveLength(1)
    const row = await BrowserSessionModel.findOne({tokenHash: sha256Hex(rotated!)}).lean()
    expect(row?.previousTokenHash).toBe(sha256Hex(old))

    // What Core signed is what the fake Fleet would have verified.
    const [call] = received
    expect(call.pathWithQuery).toBe("/v1/admin/ui/entry.js")
    const principal = verifyForwardedPrincipal(
      {method: call.method, pathWithQuery: call.pathWithQuery, body: call.body, headers: call.headers},
      [SECRET],
    )
    expect(principal).toMatchObject({kind: "user", mentraUserId: admin.mentraUserId, scope: {kind: "organization"}})
  })

  test("so does it on every other answer Fleet can give for the module", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const answers: Record<string, [() => Response, number]> = {
      "a 304": [() => new Response(null, {status: 304, headers: {etag: '"entry-v1"'}}), 304],
      "a 404": [() => Response.json({error: "nope"}, {status: 404}), 404],
      "Fleet's 401 (relayed as 403)": [() => Response.json({error: "no"}, {status: 401}), 403],
      "a 500 (answered 503)": [() => Response.json({error: "down"}, {status: 500}), 503],
      "html (answered 503)": [() => new Response("<script>x()</script>", {headers: {"content-type": "text/html"}}), 503],
      "a svg": [() => new Response("<svg/>", {headers: {"content-type": "image/svg+xml"}}), 200],
    }

    for (const [name, [reply, status]] of Object.entries(answers)) {
      answer = reply
      const old = await staleSession(admin)

      const response = await app.request(`${ADMIN_ORIGIN}/api/admin/fleet/ui/entry.js`, {headers: {cookie: `${ADMIN_COOKIE}=${old}`}})
      await response.arrayBuffer()

      expect([name, response.status]).toEqual([name, status])
      const rotated = cookieValue(response, ADMIN_COOKIE)
      expect([name, !!rotated, rotated !== old]).toEqual([name, true, true])
    }
  })

  test("html is never relayed from the portal's origin, whatever the status", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const status of [200, 404]) {
      answer = () => new Response("<script>steal()</script>", {status, headers: {"content-type": "text/html; charset=utf-8"}})
      const reply = await fromPerson(admin, "GET", "/ui/page.html")
      expect([status, reply.status, reply.json]).toEqual([status, 503, {error: "fleet_unavailable"}])
      expect(reply.text.includes("steal")).toBe(false)
    }
  })

  test("it has the Fleet gates: keys, a member, a phone token and nobody never reach Fleet, and only GET and HEAD are allowed", async () => {
    const keys = [await workspaceKey(), await operatorKey(["organization.testing.read", "organization.incidents.read"])]
    const member = await person("ws-owner")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const phone = await phoneSession("e")

    for (const method of ["GET", "HEAD"]) {
      for (const token of keys) {
        const reply = await send(method, "/api/admin/fleet/ui/entry.js", {headers: {authorization: `Bearer ${token}`}})
        expect([token.slice(0, 4), method, reply.status]).toEqual([token.slice(0, 4), method, 403])
      }
      for (const via of ["session", "bearer"] as const) {
        const reply = await fromPerson(member, method, "/ui/entry.js", {via})
        expect([via, method, reply.status]).toEqual([via, method, 403])
      }
      const phoneReply = await send(method, "/api/admin/fleet/ui/entry.js", {headers: {authorization: `Bearer ${phone.token}`}})
      expect([method, phoneReply.status]).toEqual([method, 401])
      const nobody = await send(method, "/api/admin/fleet/ui/entry.js")
      expect([method, nobody.status]).toEqual([method, 401])
    }
    expect(received).toHaveLength(0)

    for (const method of ["POST", "PUT", "DELETE"]) {
      const reply = await fromPerson(admin, method, "/ui/entry.js", {body: "{}"})
      expect([method, reply.status, reply.json]).toEqual([method, 405, {error: "method_not_allowed"}])
      expect(reply.headers.get("allow")).toBe("GET, HEAD")
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


// --- The workspace portal ----------------------------------------------------

/** A person with a workspace portal session (and a bearer), as `person` makes an admin portal one. */
async function portalPerson(key: string, options: {email?: string} = {}): Promise<Person> {
  const who = await person(key, options)
  const {cookieValue} = await createPortalSession("portal", {
    mentraUserId: who.mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: who.sub,
    email: who.email,
    emailVerified: true,
    authTime: new Date(),
  })
  return {...who, cookie: `${PORTAL_COOKIE}=${cookieValue}`}
}

/** A request to `/api/portal/fleet<rest>` by a person's workspace portal session, or their bearer when `via` is "bearer". */
function fromPortal(
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
  return send(method, `/api/portal/fleet${rest}`, {...request, headers})
}

const actorOf = (who: Person): Actor & {kind: "user"} => ({
  kind: "user",
  mentraUserId: who.mentraUserId,
  email: who.email,
  emailVerified: true,
  isOrganizationAdmin: false,
})

let membershipSeq = 0
/** A workspace owned by `owner`, and one member per role given. */
async function workspaceWith(owner: Person, roles: Record<string, Person> = {}) {
  const {workspaceId} = await createWorkspace(actorOf(owner), {name: "Acme"})
  for (const [role, who] of Object.entries(roles)) {
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: `wm_portal_${membershipSeq++}`,
        workspaceId,
        mentraUserId: who.mentraUserId,
        email: who.email,
        role,
        status: "active",
        startedAt: new Date(),
      }),
    )
  }
  return workspaceId
}

describe("the workspace portal", () => {
  test("an Owner reaches Fleet with the one workspace in the path as scope, as a verified person", async () => {
    const owner = await portalPerson("p-owner")
    const ws = await workspaceWith(owner)

    const reply = await fromPortal(owner, "GET", `/workspaces/${ws}/people?q=m`)

    expect(reply.status).toBe(200)
    const echo = reply.json as Echo
    expect(echo.pathWithQuery).toBe(`/v1/portal/workspaces/${ws}/people?q=m`)
    expect(echo.principal).toEqual({
      kind: "user",
      mentraUserId: owner.mentraUserId,
      email: owner.email,
      emailVerified: true,
      isOrganizationAdmin: false,
      organizationCapabilities: [],
      scope: {kind: "workspace", workspaceId: ws},
    })
    // Nothing of the portal session goes to Fleet.
    expect(received[0]!.headers.get("cookie")).toBeNull()
    expect(received[0]!.headers.get("authorization")).toBeNull()
  })

  test("an Admin reads and writes; a write carries its body and the portal's origin check applies", async () => {
    const owner = await portalPerson("p-owner")
    const admin = await portalPerson("p-admin")
    const ws = await workspaceWith(owner, {admin})

    expect((await fromPortal(admin, "GET", `/workspaces/${ws}/overview`)).status).toBe(200)
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const body = JSON.stringify({packageName: "com.acme.app", method})
      const reply = await fromPortal(admin, method, `/workspaces/${ws}/assignments`, {
        headers: {"content-type": "application/json"},
        body: method === "DELETE" ? undefined : body,
      })
      expect({method, status: reply.status}).toEqual({method, status: 200})
      expect((reply.json as Echo).principal).toMatchObject({scope: {kind: "workspace", workspaceId: ws}})
    }
    expect((await fromPortal(admin, "POST", `/workspaces/${ws}/assignments`, {body: "{}", headers: {origin: "https://evil.test"}})).status).toBe(403)
    expect(received.map(call => call.method)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"])
    expect(received[1]!.body).toBe(JSON.stringify({packageName: "com.acme.app", method: "POST"}))
  })

  test("a Member and a Developer get 403 on reads and writes, and Fleet is never called", async () => {
    const owner = await portalPerson("p-owner")
    const member = await portalPerson("p-member")
    const developer = await portalPerson("p-dev")
    const ws = await workspaceWith(owner, {member, developer})
    for (const who of [member, developer]) {
      for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
        const reply = await fromPortal(who, method, `/workspaces/${ws}/people`)
        expect({method, status: reply.status}).toEqual({method, status: 403})
      }
    }
    expect(received).toEqual([])
  })

  test("read-only: fleet.read without miniapps.assign can GET and is 403 on POST and DELETE", async () => {
    const owner = await portalPerson("p-owner")
    const ws = await workspaceWith(owner)
    const real = authorization.authorize
    const spy = spyOn(authorization, "authorize").mockImplementation(async (principal, request) => {
      const decision = await real(principal, request)
      if (request.capability !== "miniapps.assign" || !decision.allowed) return decision
      return {...decision, allowed: false, reason: "capability_missing"}
    })
    try {
      expect((await fromPortal(owner, "GET", `/workspaces/${ws}/people`)).status).toBe(200)
      expect((await fromPortal(owner, "POST", `/workspaces/${ws}/assignments`, {body: "{}"})).status).toBe(403)
      expect((await fromPortal(owner, "DELETE", `/workspaces/${ws}/assignments/a1`)).status).toBe(403)
      expect(received.map(call => call.method)).toEqual(["GET"])
    } finally {
      spy.mockRestore()
    }
  })

  test("a non-member is 403, and an unknown or deleted workspace is 404, whatever the method", async () => {
    const owner = await portalPerson("p-owner")
    const stranger = await portalPerson("p-stranger")
    const ws = await workspaceWith(owner)
    expect((await fromPortal(stranger, "GET", `/workspaces/${ws}/people`)).status).toBe(403)
    expect((await fromPortal(stranger, "POST", `/workspaces/${ws}/assignments`, {body: "{}"})).status).toBe(403)
    const missing = await fromPortal(owner, "GET", "/workspaces/ws_missing/people")
    expect(missing.status).toBe(404)
    expect(missing.json.error).toBe("workspace_not_found")

    await deleteWorkspace(actorOf(owner), ws, {confirmName: "Acme"})
    expect((await fromPortal(owner, "GET", `/workspaces/${ws}/people`)).status).toBe(404)
    expect(received).toEqual([])
  })

  test("an Organization Admin who is not a member gets the workspace scope and an Owner's reach, with the organization's capabilities named", async () => {
    const owner = await portalPerson("p-owner")
    const admin = await portalPerson("p-org-admin", {email: ADMIN_EMAIL})
    const ws = await workspaceWith(owner)

    const read = await fromPortal(admin, "GET", `/workspaces/${ws}/people`)
    const write = await fromPortal(admin, "POST", `/workspaces/${ws}/assignments`, {body: "{}"})

    expect(read.status).toBe(200)
    expect(write.status).toBe(200)
    expect((read.json as Echo).principal).toEqual({
      kind: "user",
      mentraUserId: admin.mentraUserId,
      email: ADMIN_EMAIL,
      emailVerified: true,
      isOrganizationAdmin: true,
      organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
      scope: {kind: "workspace", workspaceId: ws},
    })
  })

  test("the scope is the path's workspace however the request asks for another", async () => {
    const owner = await portalPerson("p-owner")
    const other = await portalPerson("p-other-owner")
    const mine = await workspaceWith(owner)
    const theirs = await workspaceWith(other)

    const reply = await fromPortal(owner, "POST", `/workspaces/${mine}/assignments?workspaceId=${theirs}&scope=organization`, {
      headers: {
        "content-type": "application/json",
        "x-mentra-workspace-id": theirs,
        "x-mentra-principal": Buffer.from(JSON.stringify({kind: "user", scope: {kind: "organization"}})).toString("base64url"),
        "x-mentra-principal-signature": "forged",
      },
      body: JSON.stringify({workspaceId: theirs, scope: {kind: "organization"}}),
    })

    expect(reply.status).toBe(200)
    expect((reply.json as Echo).principal).toMatchObject({scope: {kind: "workspace", workspaceId: mine}, isOrganizationAdmin: false})
    // A path naming another workspace the person is not in is refused before Fleet.
    expect((await fromPortal(owner, "GET", `/workspaces/${theirs}/people`)).status).toBe(403)
  })

  test("no organization-scoped route is reachable: only workspaces and ui are routes", async () => {
    const owner = await portalPerson("p-owner")
    await workspaceWith(owner)
    for (const rest of ["", "/", "/organization/overview", "/overview", "/workspaces", "/workspaces/", "/Workspaces/x/people", "/UI/x.js", "/ui", "/ui/"]) {
      const reply = await fromPortal(owner, "GET", rest)
      expect({rest, status: reply.status}).toEqual({rest, status: 404})
    }
    expect(received).toEqual([])
  })

  test("a path that tries to escape is 400 and goes nowhere", async () => {
    const owner = await portalPerson("p-owner")
    const ws = await workspaceWith(owner)
    // `..` and `%2e%2e` are collapsed by the URL parser before Core sees them; these spellings survive it.
    for (const rest of [`/workspaces/${ws}/a%2fb`, `/workspaces/${ws}%2fx/people`, `/workspaces/${ws}/%252e`, `/workspaces/${ws}/a%5cb`, `/workspaces/${ws}/%00`, `/workspaces/${ws}/%zz`]) {
      expect((await fromPortal(owner, "GET", rest)).status).toBe(400)
    }
    expect(received).toEqual([])
  })

  test("only the portal's own session reaches it: a bearer, the admin cookie, keys and no credentials do not", async () => {
    const owner = await portalPerson("p-owner")
    const ws = await workspaceWith(owner)
    expect((await fromPortal(owner, "GET", `/workspaces/${ws}/people`, {via: "bearer"})).status).toBe(403)
    // The admin portal's cookie is not read on the workspace portal's routes.
    const adminCookie = (await person("p-owner-admin-cookie")).cookie
    expect((await send("GET", `/api/portal/fleet/workspaces/${ws}/people`, {headers: {cookie: adminCookie}})).status).toBe(401)
    for (const token of [await operatorKey(["organization.testing.read"]), await workspaceKey()]) {
      const reply = await send("GET", `/api/portal/fleet/workspaces/${ws}/people`, {headers: {authorization: `Bearer ${token}`}})
      expect(reply.status).toBe(403)
    }
    expect((await send("GET", `/api/portal/fleet/workspaces/${ws}/people`)).status).toBe(401)
    expect((await send("GET", `/api/portal/fleet/workspaces/${ws}/ui/main.js`)).status).toBe(401)
    // A phone's token is not a portal session either.
    const phone = await phoneSession("p-phone")
    expect((await send("GET", `/api/portal/fleet/workspaces/${ws}/people`, {headers: {authorization: `Bearer ${phone.token}`}})).status).toBe(401)
    expect(received).toEqual([])
  })

  test("Fleet's own failures map as on the other surfaces, and a 401 from it is a 403 that does not sign the person out", async () => {
    const owner = await portalPerson("p-owner")
    const ws = await workspaceWith(owner)
    answer = () => new Response("{}", {status: 401, headers: {"content-type": "application/json"}})
    const refused = await fromPortal(owner, "GET", `/workspaces/${ws}/people`)
    expect(refused.status).toBe(403)
    answer = () => new Response("oops", {status: 500})
    const failed = await fromPortal(owner, "GET", `/workspaces/${ws}/people`)
    expect(failed.status).toBe(503)
    expect(failed.json.error).toBe("fleet_unavailable")
    answer = null
    // The session still works.
    expect((await fromPortal(owner, "GET", `/workspaces/${ws}/people`)).status).toBe(200)
  })

  test("a deployment without Fleet answers 404 fleet_not_installed to a signed-in person, and 503 when it is misconfigured", async () => {
    const owner = await portalPerson("p-owner")
    const ws = await workspaceWith(owner)
    restoreEnv()
    restoreEnv = applyEnv({...TEST_ENV, CLOUD_CORE_FLEET_URL: undefined, CLOUD_CORE_FLEET_SECRET: undefined})
    const missing = await fromPortal(owner, "GET", `/workspaces/${ws}/people`)
    expect(missing.status).toBe(404)
    expect(missing.json.error).toBe("fleet_not_installed")
    restoreEnv()
    restoreEnv = applyEnv({...TEST_ENV, CLOUD_CORE_FLEET_URL: `http://127.0.0.1:${fleet.port}`, CLOUD_CORE_FLEET_SECRET: undefined})
    const broken = await fromPortal(owner, "GET", `/workspaces/${ws}/people`)
    expect(broken.status).toBe(503)
    expect(received).toEqual([])
  })

  test("there is no unscoped UI route: /api/portal/fleet/ui/* is a 404 for every signed-in person and nothing is forwarded", async () => {
    const owner = await portalPerson("p-owner")
    const member = await portalPerson("p-member")
    await workspaceWith(owner, {member})
    for (const who of [owner, member]) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const reply = await fromPortal(who, method, "/ui/entry.js?v=1", method === "POST" ? {body: "{}"} : undefined)
        expect(reply.status).toBe(404)
      }
    }
    expect(received).toEqual([])
  })

  test("a workspace's UI assets are behind its fleet.read: relayed from /v1/portal/ui as the person", async () => {
    const owner = await portalPerson("p-owner")
    const admin = await portalPerson("p-admin")
    const orgAdmin = await portalPerson("p-org-admin", {email: ADMIN_EMAIL})
    const ws = await workspaceWith(owner, {admin})
    for (const who of [owner, admin, orgAdmin]) {
      const get = await fromPortal(who, "GET", `/workspaces/${ws}/ui/chunks/main.js?v=1`)
      const head = await fromPortal(who, "HEAD", `/workspaces/${ws}/ui/entry.js`)
      expect(get.status).toBe(200)
      expect(head.status).toBe(200)
      expect((get.json as Echo).pathWithQuery).toBe("/v1/portal/ui/chunks/main.js?v=1")
      expect((get.json as Echo).principal).toMatchObject({kind: "user", scope: {kind: "person"}})
      expect(get.headers.get("x-content-type-options")).toBe("nosniff")
      expect(get.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    }
    const sent = received.length
    expect((await fromPortal(owner, "POST", `/workspaces/${ws}/ui/entry.js`, {body: "{}"})).status).toBe(405)
    expect((await fromPortal(owner, "DELETE", `/workspaces/${ws}/ui/entry.js`)).status).toBe(405)
    expect(received).toHaveLength(sent)
  })

  test("a workspace's UI assets refuse who its API refuses, and other spellings of ui are not routes", async () => {
    const owner = await portalPerson("p-owner")
    const member = await portalPerson("p-member")
    const developer = await portalPerson("p-dev")
    const stranger = await portalPerson("p-stranger")
    const ws = await workspaceWith(owner, {member, developer})
    for (const who of [member, developer, stranger]) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const reply = await fromPortal(who, method, `/workspaces/${ws}/ui/entry.js`)
        expect({method, status: reply.status}).toEqual({method, status: 403})
      }
    }
    expect((await fromPortal(owner, "GET", "/workspaces/ws_missing/ui/entry.js")).status).toBe(404)
    expect((await fromPortal(owner, "GET", `/workspaces/${ws}/ui/entry.js`, {via: "bearer"})).status).toBe(403)
    for (const rest of [`/workspaces/${ws}/UI/entry.js`, `/workspaces/${ws}/%75i/entry.js`, `/workspaces/${ws}/ui`, `/workspaces/${ws}/ui/`]) {
      const reply = await fromPortal(owner, "GET", rest)
      expect({rest, status: reply.status}).toEqual({rest, status: 404})
    }
    expect(received).toEqual([])
  })

  test("Fleet is not a portal module: the module router never forwards to it", async () => {
    const owner = await portalPerson("p-owner")
    await workspaceWith(owner)
    const reply = await send("GET", "/api/portal/billing/ui/x.js", {headers: {cookie: owner.cookie}})
    expect(reply.status).toBe(404)
    expect(received).toEqual([])
  })
})

describe("the workspace portal's /me", () => {
  test("carries what Fleet's UI needs: user, organization capabilities, the person's workspace and whether Fleet is installed", async () => {
    const owner = await portalPerson("p-owner")
    const ws = await workspaceWith(owner)
    const reply = await send("GET", "/api/portal/me", {headers: {cookie: owner.cookie}})
    expect(reply.status).toBe(200)
    expect(reply.json.user).toMatchObject({mentraUserId: owner.mentraUserId, id: owner.mentraUserId, email: owner.email})
    expect(reply.json.organization).toEqual({capabilities: []})
    expect(reply.json.fleet).toEqual({installed: true})
    expect(reply.json.workspaces).toEqual([
      {workspaceId: ws, name: "Acme", capabilities: expect.arrayContaining(["fleet.read", "miniapps.assign"])},
    ])
  })

  test("a Member's workspace carries no Fleet capability; a person in none has none", async () => {
    const owner = await portalPerson("p-owner")
    const member = await portalPerson("p-member")
    const nobody = await portalPerson("p-nobody")
    await workspaceWith(owner, {member})
    const asMember = await send("GET", "/api/portal/me", {headers: {cookie: member.cookie}})
    expect(asMember.json.workspaces[0].capabilities).not.toContain("fleet.read")
    expect(asMember.json.workspaces[0].capabilities).not.toContain("miniapps.assign")
    expect((await send("GET", "/api/portal/me", {headers: {cookie: nobody.cookie}})).json.workspaces).toEqual([])
  })

  test("an Organization Admin asking about the open workspace gets exactly it, as an Owner; anyone else's ?workspaceId changes nothing", async () => {
    const owner = await portalPerson("p-owner")
    const admin = await portalPerson("p-org-admin", {email: ADMIN_EMAIL})
    const stranger = await portalPerson("p-stranger")
    const ws = await workspaceWith(owner)

    const asAdmin = await send("GET", `/api/portal/me?workspaceId=${ws}`, {headers: {cookie: admin.cookie}})
    expect(asAdmin.json.workspaces).toHaveLength(1)
    expect(asAdmin.json.workspaces[0]).toMatchObject({workspaceId: ws, name: "Acme"})
    expect(asAdmin.json.workspaces[0].capabilities).toEqual(expect.arrayContaining(["fleet.read", "miniapps.assign"]))
    expect(asAdmin.json.organization.capabilities.length).toBeGreaterThan(0)

    expect((await send("GET", "/api/portal/me?workspaceId=ws_missing", {headers: {cookie: admin.cookie}})).json.workspaces).toEqual([])
    expect((await send("GET", `/api/portal/me?workspaceId=${ws}`, {headers: {cookie: stranger.cookie}})).json.workspaces).toEqual([])
  })
})
