/**
 * @fileoverview Internal workspace service API tests (`/api/internal/workspaces`).
 *
 * The Store and the Fleet integration call this API with the contract's
 * `createCoreWorkspaceClient`. Most tests drive that real client with a `fetch`
 * that hands each request to the real app, so signing, verification, the
 * routes and the response checks the client makes are exercised end to end.
 * Tests of what a client never sends (a forged, stale or tampered request, an
 * oversized body, a route the client has no method for) sign requests by hand
 * with the contract's `signServiceRequest`.
 *
 * Only the WorkOS identity adapter is stubbed (a bearer maps to a fixed WorkOS
 * identity, as in `principal-auth.integration.test.ts`). Memberships, identity
 * links, credentials and audit events are real rows on a local replica set.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/workspaces-internal-api.integration.test.ts`
 */

import {createHmac} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {createWorkspaceCredential} from "../packages/core/src/services/workspaces/credential.service"
import {resolveWorkosUser} from "../packages/core/src/services/workspaces/identity-link.service"
import {
  createWorkspace,
  deleteWorkspace,
  leaveWorkspace,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import * as developerAuth from "../packages/developer-auth/src/index"
import {
  CoreWorkspaceClientError,
  createCoreWorkspaceClient,
  SERVICE_HEADERS,
  signServiceRequest,
  type CoreWorkspaceClient,
} from "../packages/workspace-contract/src/server"
import {capabilitiesForRole} from "../packages/workspace-contract/src/index"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

// Index builds and per-test cleanup on a shared, busy local replica set can take longer than the 5 s default.
setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  IdentityLinkModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const ADMIN_EMAIL = "org-admin@example.test"
const ENV_KEYS = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
  "CLOUD_CORE_SERVICE_SECRETS",
  "MENTRA_SERVICE_AUTH_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

const SERVICE_SECRETS = {store: ["store-s1", "store-s0"], fleet: ["fleet-f1"]}
const BASE = "https://core.test"
const API = "/api/internal/workspaces"
const BODY_LIMIT = 64 * 1024

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>

// --- WorkOS stub -----------------------------------------------------------

interface Identity {
  id: string
  email: string
  emailVerified: boolean
  /** The WorkOS profile lookup failed, so `emailVerified` is unknown rather than false. */
  profileUnavailable?: boolean
}

/** WorkOS access token -> the identity it stands for. */
const identities = new Map<string, Identity>()
let requestAuth: ReturnType<typeof spyOn>
let tokenAuth: ReturnType<typeof spyOn>

function authResult(value: string | undefined): developerAuth.DeveloperAuthResult {
  const identity = value ? identities.get(value) : undefined
  if (!identity) return {authenticated: false, reason: "invalid_token"}
  return {
    authenticated: true,
    user: {
      id: identity.id,
      email: identity.email,
      emailVerified: identity.emailVerified,
      firstName: "Test",
      lastName: "User",
    },
    organizationId: null,
    accessToken: value!,
    ...(identity.profileUnavailable ? {profileUnavailable: true} : {}),
  }
}

// --- Fixtures --------------------------------------------------------------

interface Person {
  bearer: string
  workosUserId: string
  email: string
  mentraUserId: string
}

/** A signed-in WorkOS person with a linked Mentra user, reachable with the bearer `person.bearer`. */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const workosUserId = `workos_${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  const bearer = `tok-${key}`
  identities.set(bearer, {id: workosUserId, email, emailVerified})
  const {mentraUserId} = await resolveWorkosUser({workosUserId, email, emailVerified, name: null})
  return {bearer, workosUserId, email, mentraUserId}
}

function actorOf(p: Person, isOrganizationAdmin = false): Actor & {kind: "user"} {
  return {kind: "user", mentraUserId: p.mentraUserId, email: p.email, emailVerified: true, isOrganizationAdmin}
}

let membershipCounter = 0
async function addMember(workspaceId: string, p: Person, role: string, fields: Record<string, unknown> = {}) {
  const membershipId = `wm_test_${membershipCounter++}`
  await WorkspaceMembershipModel.create({
    membershipId,
    workspaceId,
    mentraUserId: p.mentraUserId,
    email: p.email,
    role,
    status: "active",
    startedAt: new Date(),
    ...fields,
  })
  return membershipId
}

/** A workspace owned by "owner", with a developer, an admin and a plain member. */
async function newWorkspace(name = "Acme") {
  const owner = await person("owner")
  const developer = await person("developer")
  const admin = await person("admin")
  const member = await person("member")
  const stranger = await person("stranger")
  const workspace = await createWorkspace(actorOf(owner), {name})
  const workspaceId = workspace.workspaceId
  await addMember(workspaceId, developer, "developer")
  await addMember(workspaceId, admin, "admin")
  await addMember(workspaceId, member, "member")
  return {workspaceId, workspace, owner, developer, admin, member, stranger}
}

// --- Calling the app -------------------------------------------------------

/**
 * Configure the account directory so a first sign-in needs WorkOS's verdict on the email: when WorkOS
 * cannot give one, that sign-in is refused (`identity_unavailable`) instead of linked on a guess.
 * Never reached: the refusal comes before any directory lookup.
 */
function configureAccountDirectory() {
  process.env.SUPABASE_URL = "http://127.0.0.1:9"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unused-test-key"
}

/** A WorkOS identity that has never signed in and whose profile WorkOS cannot be asked about. */
function unvouchedNewcomer(token: string) {
  configureAccountDirectory()
  identities.set(token, {
    id: `workos_${token}`,
    email: `${token}@example.test`,
    emailVerified: false,
    profileUnavailable: true,
  })
}

/** The `fetch` the contract client uses: every request goes straight to the real app. */
const coreFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch

function clientFor(service: "store" | "fleet" | string, options: {secret?: string} = {}): CoreWorkspaceClient {
  return createCoreWorkspaceClient({
    baseUrl: BASE,
    service,
    secret: options.secret ?? secretFor(service),
    fetch: coreFetch,
  })
}

function secretFor(service: string): string {
  return service === "fleet" ? "fleet-f1" : "store-s1"
}

const store = () => clientFor("store")

async function expectClientError(promise: Promise<unknown>, code: CoreWorkspaceClientError["code"], status?: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CoreWorkspaceClientError)
  expect((error as CoreWorkspaceClientError).code).toBe(code)
  if (status !== undefined) expect((error as CoreWorkspaceClientError).status).toBe(status)
  return error as CoreWorkspaceClientError
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

interface RawOptions {
  /** `x-mentra-service`; defaults to "store". */
  service?: string
  /** Signing secret; defaults to the service's configured primary secret. */
  secret?: string
  body?: unknown
  /** The body bytes exactly as sent (overrides `body`). */
  rawBody?: string
  timestampMs?: number
  /** Sign this path (and body) instead of what is sent, to model tampering in flight. */
  signedPath?: string
  signedBody?: string
  omit?: Array<keyof typeof SERVICE_HEADERS>
  headers?: Record<string, string>
}

/** One hand-signed request through the real app. */
async function raw(method: "GET" | "POST", pathWithQuery: string, options: RawOptions = {}): Promise<Reply> {
  const service = options.service ?? "store"
  const body = options.rawBody ?? (options.body === undefined ? "" : JSON.stringify(options.body))
  const timestampMs = options.timestampMs ?? Date.now()
  const headers: Record<string, string> = {
    [SERVICE_HEADERS.service]: service,
    [SERVICE_HEADERS.timestamp]: String(timestampMs),
    [SERVICE_HEADERS.signature]: signServiceRequest({
      secret: options.secret ?? secretFor(service),
      method,
      pathWithQuery: options.signedPath ?? pathWithQuery,
      body: options.signedBody ?? body,
      timestampMs,
    }),
    ...options.headers,
  }
  for (const header of options.omit ?? []) delete headers[SERVICE_HEADERS[header]]
  if (method === "POST") headers["content-type"] = "application/json"
  return send(method, pathWithQuery, headers, method === "POST" ? body : undefined)
}

async function send(method: string, pathWithQuery: string, headers: Record<string, string>, body?: string) {
  const response = await app.fetch(new Request(`${BASE}${pathWithQuery}`, {method, headers, body}))
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, headers: response.headers, json, text}
}

/** Signed headers for a request, to send under a different method or path than was signed. */
function signedHeaders(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const timestampMs = Date.now()
  return {
    [SERVICE_HEADERS.service]: "store",
    [SERVICE_HEADERS.timestamp]: String(timestampMs),
    [SERVICE_HEADERS.signature]: signServiceRequest({secret: "store-s1", method, pathWithQuery, body, timestampMs}),
  }
}

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("workspaces-internal-api")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))

  requestAuth = spyOn(developerAuth, "authenticateWorkosRequest").mockImplementation((async (c: any) => {
    const header = c.req.header("authorization")
    return authResult(header?.startsWith("Bearer ") ? header.slice(7) : undefined)
  }) as any)
  tokenAuth = spyOn(developerAuth, "authenticateWorkosAccessToken").mockImplementation((async (token: string) =>
    authResult(token)) as any)
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  requestAuth?.mockRestore()
  tokenAuth?.mockRestore()
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  identities.clear()
  process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  delete process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
  delete process.env.CLOUD_CORE_ENVIRONMENT
  delete process.env.MENTRA_SERVICE_AUTH_SECRET
  process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify(SERVICE_SECRETS)
  // No GoTrue: a first sign-in links to a `workos` tenant user.
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.WORKOS_API_KEY = "test-workos-service-secret"
  process.env.WORKOS_CLIENT_ID = "client_test"
  process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-password-with-at-least-32-characters"
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

// --- Service authentication ------------------------------------------------

describe("service authentication", () => {
  test("an unsigned call is 401 service_unauthorized, whatever the route", async () => {
    for (const [method, path] of [
      ["POST", `${API}/authorize`],
      ["POST", `${API}/principal`],
      ["POST", `${API}/memberships/check`],
      ["POST", `${API}/credentials`],
      ["GET", `${API}/workspaces/ws_1`],
      ["GET", `${API}/changes`],
      ["GET", `${API}/workspaces/ws_1/memberships/history?mentraUserId=mu_1`],
      ["GET", `${API}/no-such-route`],
    ] as const) {
      const reply = await send(method, path, {}, method === "POST" ? "{}" : undefined)
      expect({path, status: reply.status, body: reply.json}).toEqual({
        path,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
  })

  test("a missing header is 401", async () => {
    for (const omitted of ["service", "timestamp", "signature"] as const) {
      const reply = await raw("GET", `${API}/changes`, {omit: [omitted]})
      expect({omitted, status: reply.status, body: reply.json}).toEqual({
        omitted,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
  })

  test("a wrong secret is 401 service_unauthorized, which the client reports as such", async () => {
    const reply = await raw("GET", `${API}/changes`, {secret: "not-the-secret"})
    expect(reply.status).toBe(401)
    expect(reply.json).toEqual({error: "service_unauthorized"})

    await expectClientError(
      clientFor("store", {secret: "not-the-secret"}).listChanges(null),
      "service_unauthorized",
      401,
    )
  })

  test("a secret that belongs to another service does not authenticate this one", async () => {
    expect((await raw("GET", `${API}/changes`, {service: "store", secret: "fleet-f1"})).status).toBe(401)
    expect((await raw("GET", `${API}/changes`, {service: "fleet", secret: "store-s1"})).status).toBe(401)
  })

  test("a timestamp more than 60 seconds from now is 401, in either direction", async () => {
    const stale = await raw("GET", `${API}/changes`, {timestampMs: Date.now() - 61_000})
    const future = await raw("GET", `${API}/changes`, {timestampMs: Date.now() + 61_000})
    const near = await raw("GET", `${API}/changes`, {timestampMs: Date.now() - 30_000})

    expect(stale.status).toBe(401)
    expect(stale.json).toEqual({error: "service_unauthorized"})
    expect(future.status).toBe(401)
    expect(near.status).toBe(200)
  })

  test("a timestamp that is not a plain number of milliseconds is 401", async () => {
    for (const timestamp of ["", "abc", "1e12", "0x1", "-1", "1.5", " 1"]) {
      const reply = await raw("GET", `${API}/changes`, {headers: {[SERVICE_HEADERS.timestamp]: timestamp}})
      expect({timestamp, status: reply.status}).toEqual({timestamp, status: 401})
    }
  })

  test("an unknown service is 401, even with a valid secret of another service", async () => {
    for (const service of ["other", "core", "STORE", "", "__proto__", "constructor", "toString"]) {
      const reply = await raw("GET", `${API}/changes`, {service, secret: "store-s1"})
      expect({service, status: reply.status, body: reply.json}).toEqual({
        service,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
  })

  test("a request signed for another body, path or query is 401", async () => {
    const body = {mentraUserId: "mu_1", workspaceIds: []}
    const swappedBody = await raw("POST", `${API}/memberships/check`, {
      body,
      signedBody: JSON.stringify({...body, x: 1}),
    })
    const swappedPath = await raw("POST", `${API}/memberships/check`, {body, signedPath: `${API}/principal`})
    const swappedQuery = await raw("GET", `${API}/changes?limit=500`, {signedPath: `${API}/changes?limit=2`})
    const swappedMethod = await send("POST", `${API}/changes`, signedHeaders("GET", `${API}/changes`, ""), "")

    expect(swappedBody.status).toBe(401)
    expect(swappedPath.status).toBe(401)
    expect(swappedQuery.status).toBe(401)
    expect(swappedMethod.status).toBe(401)
  })

  test("either secret of a rotation authenticates, and a retired one does not", async () => {
    expect((await raw("GET", `${API}/changes`, {secret: "store-s1"})).status).toBe(200)
    expect((await raw("GET", `${API}/changes`, {secret: "store-s0"})).status).toBe(200)

    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["store-s1"], fleet: ["fleet-f1"]})
    expect((await raw("GET", `${API}/changes`, {secret: "store-s0"})).status).toBe(401)
    expect((await raw("GET", `${API}/changes`, {secret: "store-s1"})).status).toBe(200)
  })

  test("a blank secret in the list never authenticates, even for a signature forged with it", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["", "  ", "store-s1"]})
    const timestampMs = Date.now()
    const path = `${API}/changes`
    const forged = (secret: string) =>
      createHmac("sha256", secret)
        .update(`${timestampMs}\nGET\n${path}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
        .digest("base64url")

    for (const secret of ["", "  "]) {
      const reply = await send("GET", path, {
        [SERVICE_HEADERS.service]: "store",
        [SERVICE_HEADERS.timestamp]: String(timestampMs),
        [SERVICE_HEADERS.signature]: forged(secret),
      })
      expect({secret, status: reply.status}).toEqual({secret, status: 401})
    }
    expect((await raw("GET", path)).status).toBe(200)
  })

  test("a service with no secret configured is 401, and an unset or empty configuration authenticates nobody", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["store-s1"]})
    expect((await raw("GET", `${API}/changes`, {service: "fleet"})).status).toBe(401)

    for (const configured of [undefined, "", "   ", "{}"]) {
      if (configured === undefined) delete process.env.CLOUD_CORE_SERVICE_SECRETS
      else process.env.CLOUD_CORE_SERVICE_SECRETS = configured
      const reply = await raw("GET", `${API}/changes`)
      expect({configured, status: reply.status, body: reply.json}).toEqual({
        configured,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
  })

  test("a service name Core does not know in the configuration is ignored, not used", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["store-s1"], other: ["other-secret"]})

    expect((await raw("GET", `${API}/changes`, {service: "other", secret: "other-secret"})).status).toBe(401)
    expect((await raw("GET", `${API}/changes`)).status).toBe(200)
  })

  test("malformed configuration is 503 service_auth_misconfigured for every call, signed or not", async () => {
    const malformed = [
      "not json",
      "{",
      "[]",
      '"store-s1"',
      "null",
      "42",
      '{"store":"store-s1"}',
      '{"store":[1]}',
      '{"store":[null]}',
      '{"store":{"a":"b"}}',
      '{"store":[]}',
      '{"store":["store-s1"],"fleet":"f"}',
      // A list with nothing but blank secrets holds no usable secret: as malformed as an empty list.
      '{"store":[""]}',
      '{"store":["  "]}',
      '{"store":["", "   ", "\\t"]}',
      '{"store":["store-s1"],"fleet":[" "]}',
      '{"other":[""],"store":["store-s1"]}',
    ]
    for (const configured of malformed) {
      process.env.CLOUD_CORE_SERVICE_SECRETS = configured
      const signed = await raw("GET", `${API}/changes`)
      const unsigned = await send("GET", `${API}/changes`, {})
      const post = await raw("POST", `${API}/authorize`, {
        body: {credential: {type: "mentra_user", mentraUserId: "mu_1"}},
      })
      for (const reply of [signed, unsigned, post]) {
        expect({configured, status: reply.status, body: reply.json}).toEqual({
          configured,
          status: 503,
          body: {error: "service_auth_misconfigured"},
        })
      }
    }
  })

  test("the configuration is read on every request", async () => {
    expect((await raw("GET", `${API}/changes`)).status).toBe(200)
    process.env.CLOUD_CORE_SERVICE_SECRETS = "oops"
    expect((await raw("GET", `${API}/changes`)).status).toBe(503)
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify(SERVICE_SECRETS)
    expect((await raw("GET", `${API}/changes`)).status).toBe(200)
  })

  test("the identity bridge is unchanged: it keeps its own auth and ignores the service secrets", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = "oops"
    const reply = await send(
      "POST",
      "/api/internal/identity/resolve-email",
      {},
      JSON.stringify({email: "a@example.test"}),
    )

    expect(reply.status).toBe(401)
    expect(reply.json).toEqual({error: "unauthorized"})
  })
})

// --- Body limit ------------------------------------------------------------

describe("request body limit", () => {
  const padded = (bytes: number) => JSON.stringify({token: "x".repeat(bytes - '{"token":""}'.length)})

  test("a body of exactly 64 KiB is read, one byte more is 413 payload_too_large", async () => {
    const atLimit = padded(BODY_LIMIT)
    const overLimit = padded(BODY_LIMIT + 1)
    expect(Buffer.byteLength(atLimit)).toBe(BODY_LIMIT)

    const accepted = await raw("POST", `${API}/principal`, {rawBody: atLimit})
    const refused = await raw("POST", `${API}/principal`, {rawBody: overLimit})

    expect(accepted.status).toBe(401)
    expect(accepted.json).toEqual({error: "invalid_token"})
    expect(refused.status).toBe(413)
    expect(refused.json).toEqual({error: "payload_too_large"})
  })

  test("the limit is checked before authentication", async () => {
    const reply = await send("POST", `${API}/principal`, {"content-type": "application/json"}, padded(BODY_LIMIT + 1))

    expect(reply.status).toBe(413)
    expect(reply.json).toEqual({error: "payload_too_large"})
  })

  test("a declared Content-Length over the limit is refused without reading the body", async () => {
    const reply = await send(
      "POST",
      `${API}/principal`,
      {"content-type": "application/json", "content-length": String(BODY_LIMIT + 1)},
      "{}",
    )

    expect(reply.status).toBe(413)
    expect(reply.json).toEqual({error: "payload_too_large"})
  })

  test("a larger body is fine on other routes", async () => {
    const reply = await send("POST", "/api/internal/identity/resolve-email", {}, padded(BODY_LIMIT + 1))

    expect(reply.status).not.toBe(413)
  })
})

// --- POST /authorize -------------------------------------------------------

describe("POST /authorize", () => {
  test("a WorkOS bearer that is a member gets its role's capabilities", async () => {
    const {workspaceId, developer} = await newWorkspace()

    const decision = await store().authorize({
      credential: {type: "bearer", token: developer.bearer},
      workspaceId,
      capability: "miniapps.publish",
    })

    expect(decision.allowed).toBe(true)
    expect(decision.principal).toMatchObject({
      kind: "user",
      mentraUserId: developer.mentraUserId,
      email: developer.email,
      emailVerified: true,
      workosUserId: developer.workosUserId,
      isOrganizationAdmin: false,
    })
    expect(decision.workspace).toMatchObject({workspaceId, name: "Acme", status: "active"})
    expect(decision.membership).toEqual({membershipId: expect.stringMatching(/^wm_/), role: "developer"})
    expect([...decision.capabilities].sort()).toEqual([...capabilitiesForRole("developer")].sort())
  })

  test("a member without the capability is denied with capability_missing and the capabilities they do have", async () => {
    const {workspaceId, member} = await newWorkspace()

    const decision = await store().authorize({
      credential: {type: "bearer", token: member.bearer},
      workspaceId,
      capability: "miniapps.publish",
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("capability_missing")
    expect([...decision.capabilities].sort()).toEqual([...capabilitiesForRole("member")].sort())
  })

  test("a signed-in person who is not a member is not_a_member, and learns nothing about the workspace", async () => {
    const {workspaceId, stranger} = await newWorkspace()

    const decision = await store().authorize({credential: {type: "bearer", token: stranger.bearer}, workspaceId})

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("not_a_member")
    expect(decision.workspace).toBeUndefined()
    expect(decision.capabilities).toEqual([])
  })

  test("an msk_ token is allowed for a package in its scope and package_out_of_scope for another", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {
      name: "CI",
      packageNames: ["com.acme.app"],
    })

    const inScope = await store().authorize({
      credential: {type: "bearer", token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.acme.app",
    })
    const outOfScope = await store().authorize({
      credential: {type: "bearer", token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.other.app",
    })

    expect(inScope.allowed).toBe(true)
    expect(inScope.principal).toMatchObject({kind: "credential", credentialKind: "workspace", workspaceId})
    expect(outOfScope.allowed).toBe(false)
    expect(outOfScope.reason).toBe("package_out_of_scope")
  })

  test("a bearer that is not a valid identity is unauthenticated, and a bad credential is credential_invalid", async () => {
    const {workspaceId} = await newWorkspace()
    const badCredential = `msk_local_${"0".repeat(26)}.${"A".repeat(43)}`

    const unknownWorkos = await store().authorize({credential: {type: "bearer", token: "tok-unknown"}, workspaceId})
    const blank = await store().authorize({credential: {type: "bearer", token: "   "}, workspaceId})
    const credential = await store().authorize({credential: {type: "bearer", token: badCredential}, workspaceId})

    expect(unknownWorkos).toMatchObject({allowed: false, reason: "unauthenticated", principal: null})
    expect(blank).toMatchObject({allowed: false, reason: "unauthenticated", principal: null})
    expect(credential).toMatchObject({allowed: false, reason: "credential_invalid", principal: null})
    for (const decision of [unknownWorkos, blank, credential]) expect(decision.capabilities).toEqual([])
  })

  test("a mentra_user credential authorizes as that user's membership, as a plain user", async () => {
    const {workspaceId, admin, stranger} = await newWorkspace()

    const decision = await store().authorize({
      credential: {type: "mentra_user", mentraUserId: admin.mentraUserId},
      workspaceId,
      capability: "workspace.members.manage",
    })
    const denied = await store().authorize({
      credential: {type: "mentra_user", mentraUserId: stranger.mentraUserId},
      workspaceId,
    })

    expect(decision.allowed).toBe(true)
    expect(decision.principal).toEqual({
      kind: "user",
      mentraUserId: admin.mentraUserId,
      email: null,
      emailVerified: false,
      name: null,
      workosUserId: null,
      isOrganizationAdmin: false,
    })
    expect(decision.membership?.role).toBe("admin")
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe("not_a_member")
  })

  test("a mentra_user credential never carries Organization Admin standing, even for an allowlisted person", async () => {
    const {workspaceId} = await newWorkspace()
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})

    const asBearer = await store().authorize({
      credential: {type: "bearer", token: orgAdmin.bearer},
      workspaceId,
      capability: "workspace.delete",
    })
    const asMentraUser = await store().authorize({
      credential: {type: "mentra_user", mentraUserId: orgAdmin.mentraUserId},
      workspaceId,
      capability: "workspace.delete",
    })

    expect(asBearer.allowed).toBe(true)
    expect(asMentraUser.allowed).toBe(false)
    expect(asMentraUser.reason).toBe("not_a_member")
  })

  test("a workspace that does not exist or was deleted is denied with its own reason", async () => {
    const {workspaceId, owner} = await newWorkspace()
    const credential = {type: "mentra_user", mentraUserId: owner.mentraUserId} as const

    const missing = await store().authorize({credential, workspaceId: "ws_missing"})
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})
    const deleted = await store().authorize({credential, workspaceId})

    expect(missing).toMatchObject({allowed: false, reason: "workspace_not_found", workspace: null})
    expect(deleted).toMatchObject({allowed: false, reason: "workspace_deleted"})
    expect(deleted.workspace).toMatchObject({workspaceId, status: "deleted"})
  })

  test("with no workspace there is nothing to grant: allowed with no capabilities, and a capability is refused", async () => {
    const {developer} = await newWorkspace()
    const credential = {type: "bearer", token: developer.bearer} as const

    const allowed = await store().authorize({credential})
    const refused = await store().authorize({credential, capability: "workspace.read"})

    expect(allowed).toMatchObject({allowed: true, capabilities: []})
    expect(refused).toMatchObject({allowed: false, reason: "capability_missing"})
  })

  test("a capability Core does not know is never granted: capability_missing, with or without a workspace, even for an Organization Admin", async () => {
    const {workspaceId, owner, developer} = await newWorkspace()
    const admin = await person("root-admin", {email: ADMIN_EMAIL})
    const unknown = ["not.a.capability", "workspace.read ", "WORKSPACE.READ", "__proto__", "constructor", "toString"]

    for (const capability of unknown) {
      for (const who of [developer, owner, admin]) {
        const inWorkspace = await raw("POST", `${API}/authorize`, {
          body: {credential: {type: "bearer", token: who.bearer}, workspaceId, capability},
        })
        expect({capability, who: who.email, status: inWorkspace.status, allowed: inWorkspace.json?.allowed}).toEqual({
          capability,
          who: who.email,
          status: 200,
          allowed: false,
        })
        expect(inWorkspace.json.reason).toBe("capability_missing")
        // The denial still says what the person can do, so a caller can tell a typo from a missing role.
        expect(inWorkspace.json.capabilities.length).toBeGreaterThan(0)
        expect(inWorkspace.json.capabilities).not.toContain(capability)
      }
      const noWorkspace = await raw("POST", `${API}/authorize`, {
        body: {credential: {type: "bearer", token: developer.bearer}, capability},
      })
      expect({capability, allowed: noWorkspace.json?.allowed, reason: noWorkspace.json?.reason}).toEqual({
        capability,
        allowed: false,
        reason: "capability_missing",
      })
      const asUser = await raw("POST", `${API}/authorize`, {
        body: {credential: {type: "mentra_user", mentraUserId: developer.mentraUserId}, workspaceId, capability},
      })
      expect({capability, allowed: asUser.json?.allowed, reason: asUser.json?.reason}).toEqual({
        capability,
        allowed: false,
        reason: "capability_missing",
      })
    }

    // A real capability is unaffected.
    const known = await raw("POST", `${API}/authorize`, {
      body: {credential: {type: "bearer", token: developer.bearer}, workspaceId, capability: "miniapps.publish"},
    })
    expect(known.json).toMatchObject({allowed: true})
  })

  test("a request that is not shaped like an authorize request is 400 invalid_request", async () => {
    const bad: unknown[] = [
      {},
      {credential: null},
      {credential: "bearer"},
      {credential: {type: "basic", token: "x"}},
      {credential: {type: "bearer"}},
      {credential: {type: "bearer", token: 1}},
      {credential: {type: "mentra_user"}},
      {credential: {type: "mentra_user", mentraUserId: ""}},
      {credential: {type: "mentra_user", mentraUserId: "   "}},
      {credential: {type: "mentra_user", mentraUserId: 7}},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, workspaceId: 5},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, capability: ["workspace.read"]},
      // A blank capability is not "no capability": it would otherwise read as an unconditional allow.
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, capability: ""},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, capability: "   "},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, workspaceId: "ws_1", capability: ""},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, workspaceId: "ws_1", capability: "\t\n"},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, packageName: {}},
    ]
    for (const body of bad) {
      const reply = await raw("POST", `${API}/authorize`, {body})
      expect({body, status: reply.status, error: reply.json?.error}).toEqual({
        body,
        status: 400,
        error: "invalid_request",
      })
    }
    for (const rawBody of ["", "not json", "[]", "null", "3"]) {
      const reply = await raw("POST", `${API}/authorize`, {rawBody})
      expect({rawBody, status: reply.status, error: reply.json?.error}).toEqual({
        rawBody,
        status: 400,
        error: "invalid_request",
      })
    }
  })

  test("a first sign-in WorkOS cannot vouch for is 503 identity_unavailable", async () => {
    unvouchedNewcomer("tok-new")

    const reply = await raw("POST", `${API}/authorize`, {body: {credential: {type: "bearer", token: "tok-new"}}})

    expect(reply.status).toBe(503)
    expect(reply.json).toEqual({error: "identity_unavailable"})
    expect(await IdentityLinkModel.countDocuments({})).toBe(0)
    await expectClientError(
      store().authorize({credential: {type: "bearer", token: "tok-new"}}),
      "core_unavailable",
      503,
    )
  })

  test("an authorize answer has exactly the contract's fields, at every level", async () => {
    const {workspaceId, developer} = await newWorkspace()

    const reply = await raw("POST", `${API}/authorize`, {
      body: {credential: {type: "bearer", token: developer.bearer}, workspaceId},
    })

    expect(reply.status).toBe(200)
    expect(Object.keys(reply.json).sort()).toEqual(["allowed", "capabilities", "membership", "principal", "workspace"])
    expect(Object.keys(reply.json.principal).sort()).toEqual([
      "email",
      "emailVerified",
      "isOrganizationAdmin",
      "kind",
      "mentraUserId",
      "name",
      "workosUserId",
    ])
    expect(Object.keys(reply.json.workspace).sort()).toEqual(["authorizationRevision", "name", "status", "workspaceId"])
  })

  test("the Fleet service may authorize too", async () => {
    const {workspaceId, member} = await newWorkspace()

    const decision = await clientFor("fleet").authorize({
      credential: {type: "mentra_user", mentraUserId: member.mentraUserId},
      workspaceId,
      capability: "workspace.read",
    })

    expect(decision.allowed).toBe(true)
  })
})

// --- POST /principal -------------------------------------------------------

describe("POST /principal", () => {
  test("a WorkOS bearer resolves to the person and their active workspaces with capabilities", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const other = await createWorkspace(actorOf(developer), {name: "Second"})
    const gone = await createWorkspace(actorOf(developer), {name: "Gone"})
    await deleteWorkspace(actorOf(developer), gone.workspaceId, {confirmName: "Gone"})

    const resolved = await store().resolvePrincipal(developer.bearer)

    expect(resolved?.principal).toMatchObject({
      kind: "user",
      mentraUserId: developer.mentraUserId,
      email: developer.email,
      isOrganizationAdmin: false,
    })
    expect(resolved?.workspaces.map(workspace => workspace.workspaceId)).toEqual([workspaceId, other.workspaceId])
    expect(resolved?.workspaces[0]).toMatchObject({
      name: "Acme",
      status: "active",
      membership: {membershipId: expect.stringMatching(/^wm_/), role: "developer"},
    })
    expect(resolved?.workspaces[1]?.membership.role).toBe("owner")
    expect([...resolved!.workspaces[0]!.capabilities].sort()).toEqual([...capabilitiesForRole("developer")].sort())
  })

  test("an msk_ token resolves to its credential principal with no workspace memberships", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

    const resolved = await store().resolvePrincipal(token)

    expect(resolved?.principal).toMatchObject({kind: "credential", credentialKind: "workspace", workspaceId})
    expect(resolved?.workspaces).toEqual([])
  })

  test("a token Core does not accept is 401 invalid_token, which the client reports as null", async () => {
    await newWorkspace()
    for (const token of [
      "tok-unknown",
      "",
      "   ",
      "msk_local_garbage",
      `mak_local_${"0".repeat(26)}.${"A".repeat(43)}`,
    ]) {
      const reply = await raw("POST", `${API}/principal`, {body: {token}})
      expect({token, status: reply.status, body: reply.json}).toEqual({
        token,
        status: 401,
        body: {error: "invalid_token"},
      })
    }
    expect(await store().resolvePrincipal("tok-unknown")).toBeNull()
  })

  test("a request with no token string is 400", async () => {
    for (const body of [{}, {token: 5}, {token: null}, {token: ["a"]}, []]) {
      const reply = await raw("POST", `${API}/principal`, {body})
      expect({body, status: reply.status}).toEqual({body, status: 400})
    }
  })

  test("a first sign-in WorkOS cannot vouch for is 503 identity_unavailable, not a 401 that reads as a bad token", async () => {
    unvouchedNewcomer("tok-new")

    const reply = await raw("POST", `${API}/principal`, {body: {token: "tok-new"}})

    expect(reply.status).toBe(503)
    expect(reply.json).toEqual({error: "identity_unavailable"})
    await expectClientError(store().resolvePrincipal("tok-new"), "core_unavailable", 503)
  })

  test("a service-level 401 is not reported as an invalid token", async () => {
    await expectClientError(
      clientFor("store", {secret: "wrong"}).resolvePrincipal("tok-unknown"),
      "service_unauthorized",
    )
  })
})

// --- POST /memberships/check -----------------------------------------------

describe("POST /memberships/check", () => {
  test("answers a role and capabilities for each workspace the person is in and null for every other", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const second = await createWorkspace(actorOf(developer), {name: "Second"})
    const gone = await createWorkspace(actorOf(developer), {name: "Gone"})
    await deleteWorkspace(actorOf(developer), gone.workspaceId, {confirmName: "Gone"})
    const strangersOnly = await createWorkspace(actorOf(await person("someone-else")), {name: "Theirs"})

    const memberships = await store().checkMemberships(developer.mentraUserId, [
      workspaceId,
      second.workspaceId,
      gone.workspaceId,
      strangersOnly.workspaceId,
      "ws_unknown",
    ])

    expect(Object.keys(memberships)).toEqual([
      workspaceId,
      second.workspaceId,
      gone.workspaceId,
      strangersOnly.workspaceId,
      "ws_unknown",
    ])
    expect(memberships[workspaceId]?.role).toBe("developer")
    expect([...memberships[workspaceId]!.capabilities].sort()).toEqual([...capabilitiesForRole("developer")].sort())
    expect(memberships[second.workspaceId]?.role).toBe("owner")
    expect(memberships[gone.workspaceId]).toBeNull()
    expect(memberships[strangersOnly.workspaceId]).toBeNull()
    expect(memberships.ws_unknown).toBeNull()
  })

  test("the response is the raw map", async () => {
    const {workspaceId, member} = await newWorkspace()

    const reply = await raw("POST", `${API}/memberships/check`, {
      body: {mentraUserId: member.mentraUserId, workspaceIds: [workspaceId]},
    })

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      memberships: {[workspaceId]: {role: "member", capabilities: expect.arrayContaining(["workspace.read"])}},
    })
  })

  test("a membership that ended, or one waiting for its first sign-in, is null", async () => {
    const {workspaceId, developer, member} = await newWorkspace()
    await leaveWorkspace(actorOf(member), workspaceId)
    await WorkspaceMembershipModel.create({
      membershipId: "wm_pending",
      workspaceId,
      mentraUserId: null,
      pendingWorkosUserId: "workos_pending",
      email: "pending@example.test",
      role: "admin",
      status: "active",
      startedAt: new Date(),
    })

    const left = await store().checkMemberships(member.mentraUserId, [workspaceId])
    const stillIn = await store().checkMemberships(developer.mentraUserId, [workspaceId])

    expect(left).toEqual({[workspaceId]: null})
    expect(stillIn[workspaceId]?.role).toBe("developer")
  })

  test("a user id nobody has, and an empty list, answer without error", async () => {
    const {workspaceId} = await newWorkspace()

    expect(await store().checkMemberships("mu_nobody", [workspaceId])).toEqual({[workspaceId]: null})
    expect(await store().checkMemberships("mu_nobody", [])).toEqual({})
  })

  test("a repeated workspace id answers once, and ids that are object keys with special meaning are plain keys", async () => {
    const {workspaceId, member} = await newWorkspace()

    const memberships = await store().checkMemberships(member.mentraUserId, [
      workspaceId,
      workspaceId,
      "__proto__",
      "constructor",
    ])

    expect(Object.keys(memberships).sort()).toEqual(["__proto__", "constructor", workspaceId].sort())
    expect(Object.getOwnPropertyDescriptor(memberships, "__proto__")?.value).toBeNull()
    expect(memberships[workspaceId]?.role).toBe("member")
  })

  test("up to 100 workspace ids are accepted and 101 are 400", async () => {
    const ids = (count: number) => Array.from({length: count}, (_, index) => `ws_${index}`)

    const hundred = await store().checkMemberships("mu_1", ids(100))
    const tooMany = await raw("POST", `${API}/memberships/check`, {
      body: {mentraUserId: "mu_1", workspaceIds: ids(101)},
    })

    expect(Object.keys(hundred)).toHaveLength(100)
    expect(tooMany.status).toBe(400)
    expect(tooMany.json.error).toBe("invalid_request")
  })

  test("a request that is not a user id and a list of non-empty workspace id strings is 400", async () => {
    const bad: unknown[] = [
      {},
      {mentraUserId: "mu_1"},
      {workspaceIds: ["ws_1"]},
      {mentraUserId: "", workspaceIds: ["ws_1"]},
      {mentraUserId: "  ", workspaceIds: ["ws_1"]},
      {mentraUserId: 1, workspaceIds: ["ws_1"]},
      {mentraUserId: "mu_1", workspaceIds: "ws_1"},
      {mentraUserId: "mu_1", workspaceIds: [1]},
      {mentraUserId: "mu_1", workspaceIds: [null]},
      {mentraUserId: "mu_1", workspaceIds: [""]},
      {mentraUserId: "mu_1", workspaceIds: ["ws_1", ""]},
      {mentraUserId: "mu_1", workspaceIds: [["ws_1"]]},
    ]
    for (const body of bad) {
      const reply = await raw("POST", `${API}/memberships/check`, {body})
      expect({body, status: reply.status}).toEqual({body, status: 400})
    }
  })
})

// --- GET /workspaces/:workspaceId ------------------------------------------

describe("GET /workspaces/:workspaceId", () => {
  test("returns the workspace summary", async () => {
    const {workspaceId, workspace} = await newWorkspace()

    expect(await store().getWorkspace(workspaceId)).toEqual({
      workspaceId,
      name: "Acme",
      status: "active",
      authorizationRevision: workspace.authorizationRevision,
    })
  })

  test("a deleted workspace is still described, with its status", async () => {
    const {workspaceId, owner} = await newWorkspace()
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})

    expect(await store().getWorkspace(workspaceId)).toMatchObject({workspaceId, status: "deleted"})
  })

  test("an unknown workspace is 404 workspace_not_found, which the client reports as null", async () => {
    await newWorkspace()

    const reply = await raw("GET", `${API}/workspaces/ws_missing`)

    expect(reply.status).toBe(404)
    expect(reply.json).toEqual({error: "workspace_not_found"})
    expect(await store().getWorkspace("ws_missing")).toBeNull()
  })

  test("an id that needs escaping in the path is found, and still verifies", async () => {
    await newWorkspace()
    const odd = "ws/odd id?x=1"
    await WorkspaceModel.create({
      workspaceId: odd,
      name: "Odd",
      status: "active",
      authorizationRevision: 0,
    })

    expect(await store().getWorkspace(odd)).toMatchObject({workspaceId: odd, name: "Odd"})
  })

  test("the Fleet service may read it too", async () => {
    const {workspaceId} = await newWorkspace()

    expect(await clientFor("fleet").getWorkspace(workspaceId)).toMatchObject({workspaceId})
  })
})

// --- GET /changes ----------------------------------------------------------

async function seedEvents(count: number, firstSeq = 1) {
  await WorkspaceAuditEventModel.insertMany(
    Array.from({length: count}, (_, index) => ({
      eventId: `evt_${String(firstSeq + index).padStart(5, "0")}`,
      seq: firstSeq + index,
      workspaceId: null,
      action: "test.event",
      actor: {kind: "system"},
      target: {n: firstSeq + index},
      occurredAt: new Date(),
    })),
  )
}

describe("GET /changes", () => {
  test("pages the change feed by seq through the client", async () => {
    const {workspaceId, developer} = await newWorkspace()
    await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

    const all = await store().listChanges(null, 500)
    expect(all.events.map(event => event.action)).toEqual(["workspace.created", "credential.created"])
    expect(all.events.map(event => event.seq)).toEqual([1, 2])
    expect(all.events[0]).toMatchObject({workspaceId})
    expect(all.next).toBeNull()

    const first = await store().listChanges(null, 1)
    expect(first.events).toHaveLength(1)
    expect(first.next).toBe(String(first.events[0]!.seq))
    const second = await store().listChanges(first.next, 1)
    expect(second.events[0]!.seq).toBe(first.events[0]!.seq + 1)
  })

  test("the page size defaults to 100 and is capped at 500", async () => {
    await seedEvents(505)

    const first = await raw("GET", `${API}/changes`)
    expect(first.status).toBe(200)
    expect(Object.keys(first.json).sort()).toEqual(["events", "next"])
    expect(first.json.events).toHaveLength(100)
    expect(first.json.next).toBe("100")

    const capped = await raw("GET", `${API}/changes?limit=501`)
    expect(capped.json.events).toHaveLength(500)
    expect(capped.json.next).toBe("500")

    const rest = await raw("GET", `${API}/changes?after=500&limit=500`)
    expect(rest.json.events.map((event: {seq: number}) => event.seq)).toEqual([501, 502, 503, 504, 505])
    expect(rest.json.next).toBeNull()
  })

  test("a credential's token and hash never appear in the feed", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

    const reply = await raw("GET", `${API}/changes?limit=500`)

    expect(reply.text).toContain("credential.created")
    expect(reply.text).not.toContain(token)
    expect(reply.text).not.toContain(token.split(".")[1]!)
  })

  test("a bad cursor or page size is 400", async () => {
    for (const query of [
      "after=abc",
      "after=",
      "after=1.5",
      "after=-1",
      "after=01",
      "limit=0",
      "limit=-5",
      "limit=abc",
      "limit=",
      "limit=1.5",
    ]) {
      const reply = await raw("GET", `${API}/changes?${query}`)
      expect({query, status: reply.status, error: reply.json?.error}).toEqual({
        query,
        status: 400,
        error: "invalid_request",
      })
    }
  })

  test("the Fleet service may read it too", async () => {
    await seedEvents(1)

    expect((await clientFor("fleet").listChanges(null)).events).toHaveLength(1)
  })
})

// --- GET /workspaces/:workspaceId/memberships/history ----------------------

describe("GET /workspaces/:workspaceId/memberships/history", () => {
  const history = (workspaceId: string, mentraUserId: string, options: RawOptions = {service: "fleet"}) =>
    raw(
      "GET",
      `${API}/workspaces/${workspaceId}/memberships/history?mentraUserId=${encodeURIComponent(mentraUserId)}`,
      options,
    )

  test("lists every membership interval of the person in the workspace, oldest first", async () => {
    const {workspaceId, member} = await newWorkspace()
    const first = new Date("2026-01-01T00:00:00.000Z")
    const firstEnd = new Date("2026-02-01T00:00:00.000Z")
    const second = new Date("2026-03-01T00:00:00.000Z")
    // The seeded active row is the newest; rewrite its start so the three intervals are in a known order.
    await WorkspaceMembershipModel.updateOne(
      {workspaceId, mentraUserId: member.mentraUserId},
      {startedAt: second, role: "admin"},
    )
    await WorkspaceMembershipModel.create([
      {
        membershipId: "wm_old_b",
        workspaceId,
        mentraUserId: member.mentraUserId,
        role: "member",
        status: "ended",
        startedAt: new Date("2026-02-15T00:00:00.000Z"),
        endedAt: new Date("2026-02-20T00:00:00.000Z"),
        endedReason: "left",
      },
      {
        membershipId: "wm_old_a",
        workspaceId,
        mentraUserId: member.mentraUserId,
        role: "developer",
        status: "ended",
        startedAt: first,
        endedAt: firstEnd,
        endedReason: "removed",
      },
    ])

    const reply = await history(workspaceId, member.mentraUserId)

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      items: [
        {membershipId: "wm_old_a", role: "developer", startedAt: first.toISOString(), endedAt: firstEnd.toISOString()},
        {
          membershipId: "wm_old_b",
          role: "member",
          startedAt: "2026-02-15T00:00:00.000Z",
          endedAt: "2026-02-20T00:00:00.000Z",
        },
        {membershipId: expect.stringMatching(/^wm_/), role: "admin", startedAt: second.toISOString(), endedAt: null},
      ],
    })
  })

  test("never includes another person's or another workspace's membership, or an unclaimed one", async () => {
    const {workspaceId, member, admin} = await newWorkspace()
    const otherWorkspace = await createWorkspace(actorOf(admin), {name: "Other"})
    await addMember(otherWorkspace.workspaceId, member, "owner")
    await WorkspaceMembershipModel.create({
      membershipId: "wm_unclaimed",
      workspaceId,
      mentraUserId: null,
      pendingWorkosUserId: "workos_pending",
      role: "admin",
      status: "active",
      startedAt: new Date(),
    })

    const reply = await history(workspaceId, member.mentraUserId)

    expect(reply.status).toBe(200)
    expect(reply.json.items).toHaveLength(1)
    expect(reply.json.items[0]).toMatchObject({role: "member", endedAt: null})
  })

  test("a person with no memberships, and a workspace that does not exist, have no intervals", async () => {
    const {workspaceId, stranger} = await newWorkspace()

    const none = await history(workspaceId, stranger.mentraUserId)
    const missing = await history("ws_missing", stranger.mentraUserId)

    expect(none.status).toBe(200)
    expect(none.json).toEqual({items: []})
    expect(missing.status).toBe(200)
    expect(missing.json).toEqual({items: []})
  })

  test("only the Fleet service may ask: the Store is 403 forbidden", async () => {
    const {workspaceId, member} = await newWorkspace()

    const reply = await history(workspaceId, member.mentraUserId, {service: "store"})

    expect(reply.status).toBe(403)
    expect(reply.json).toEqual({error: "forbidden"})
  })

  test("is still service-authenticated: an unsigned or wrongly signed call is 401", async () => {
    const {workspaceId, member} = await newWorkspace()
    const path = `${API}/workspaces/${workspaceId}/memberships/history?mentraUserId=${member.mentraUserId}`

    expect((await send("GET", path, {})).status).toBe(401)
    expect((await history(workspaceId, member.mentraUserId, {service: "fleet", secret: "wrong"})).status).toBe(401)
  })

  test("a missing or blank mentraUserId is 400", async () => {
    const {workspaceId} = await newWorkspace()

    for (const query of ["", "?mentraUserId=", "?mentraUserId=%20%20"]) {
      const reply = await raw("GET", `${API}/workspaces/${workspaceId}/memberships/history${query}`, {service: "fleet"})
      expect({query, status: reply.status, error: reply.json?.error}).toEqual({
        query,
        status: 400,
        error: "invalid_request",
      })
    }
  })
})

// --- POST /credentials -----------------------------------------------------

describe("POST /credentials", () => {
  const input = (workspaceId: string, overrides: Record<string, unknown> = {}) => ({
    workspaceId,
    name: "Store package key",
    packageNames: ["com.acme.app"],
    issuedBy: {service: "store", actorEmail: "staff@example.test"},
    ...overrides,
  })

  test("the Store mints a package-restricted credential that validates as an msk_ token", async () => {
    const {workspaceId} = await newWorkspace()

    const minted = await store().mintServiceCredential({
      workspaceId,
      name: "Store package key",
      packageNames: ["com.acme.app"],
      issuedBy: {service: "store", actorEmail: "staff@example.test"},
    })

    expect(minted.credentialId).toEqual(expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/))
    expect(minted.token).toStartWith("msk_local_")
    expect(minted.token).toContain(minted.credentialId)

    const inScope = await store().authorize({
      credential: {type: "bearer", token: minted.token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.acme.app",
    })
    const outOfScope = await store().authorize({
      credential: {type: "bearer", token: minted.token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.other.app",
    })
    expect(inScope.allowed).toBe(true)
    expect(outOfScope.reason).toBe("package_out_of_scope")

    const row = await AccessCredentialModel.findOne({credentialId: minted.credentialId}).lean()
    expect(row).toMatchObject({
      workspaceId,
      packageNames: ["com.acme.app"],
      issuedByService: "store",
      createdByEmail: "staff@example.test",
    })
  })

  test("the response is {credentialId, token}, created and never cached", async () => {
    const {workspaceId} = await newWorkspace()

    const reply = await raw("POST", `${API}/credentials`, {body: input(workspaceId)})

    expect(reply.status).toBe(201)
    expect(reply.headers.get("cache-control")).toBe("no-store")
    expect(Object.keys(reply.json).sort()).toEqual(["credentialId", "token"])
  })

  test("the audit trail names the authenticated service and the person who asked", async () => {
    const {workspaceId} = await newWorkspace()
    const minted = await store().mintServiceCredential({
      workspaceId,
      name: "Store package key",
      packageNames: ["com.acme.app"],
      issuedBy: {service: "store", actorEmail: "staff@example.test"},
    })

    const event = await WorkspaceAuditEventModel.findOne({action: "credential.created"}).lean()

    expect(event?.actor).toMatchObject({kind: "service", service: "store", email: "staff@example.test"})
    expect(event?.target).toMatchObject({credentialId: minted.credentialId, workspaceId})
  })

  test("the Fleet service cannot mint credentials: 403 forbidden, and nothing is created", async () => {
    const {workspaceId} = await newWorkspace()

    await expectClientError(
      clientFor("fleet").mintServiceCredential({
        workspaceId,
        name: "Not allowed",
        packageNames: ["com.acme.app"],
        issuedBy: {service: "fleet", actorEmail: "staff@example.test"},
      }),
      "forbidden",
      403,
    )
    const reply = await raw("POST", `${API}/credentials`, {service: "fleet", body: input(workspaceId)})
    expect(reply.status).toBe(403)
    expect(reply.json).toEqual({error: "forbidden"})
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("a credential cannot be issued in another service's name: a mismatched issuedBy.service is 403", async () => {
    const {workspaceId} = await newWorkspace()

    for (const service of ["fleet", "core", "", null, 7]) {
      const reply = await raw("POST", `${API}/credentials`, {
        body: input(workspaceId, {issuedBy: {service, actorEmail: "staff@example.test"}}),
      })
      expect({service, status: reply.status, error: reply.json?.error}).toEqual({
        service,
        status: 403,
        error: "forbidden",
      })
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("an omitted issuedBy.service is ignored: the issuer is the authenticated service", async () => {
    const {workspaceId} = await newWorkspace()

    const reply = await raw("POST", `${API}/credentials`, {
      body: input(workspaceId, {issuedBy: {actorEmail: "staff@example.test"}}),
    })

    expect(reply.status).toBe(201)
    const row = await AccessCredentialModel.findOne({credentialId: reply.json.credentialId}).lean()
    expect(row?.issuedByService).toBe("store")
  })

  test("a request that is not a valid credential request is 400", async () => {
    const {workspaceId} = await newWorkspace()
    const bad: unknown[] = [
      {},
      input(workspaceId, {workspaceId: undefined}),
      input(workspaceId, {workspaceId: 5}),
      input(workspaceId, {workspaceId: ""}),
      input(workspaceId, {workspaceId: "   "}),
      input(workspaceId, {workspaceId: "\t\n"}),
      input(workspaceId, {name: undefined}),
      input(workspaceId, {name: ""}),
      input(workspaceId, {packageNames: undefined}),
      input(workspaceId, {packageNames: "com.acme.app"}),
      input(workspaceId, {packageNames: [5]}),
      input(workspaceId, {packageNames: []}),
      input(workspaceId, {packageNames: ["not a package"]}),
      input(workspaceId, {issuedBy: undefined}),
      input(workspaceId, {issuedBy: "store"}),
      input(workspaceId, {issuedBy: {service: "store"}}),
      input(workspaceId, {issuedBy: {service: "store", actorEmail: ""}}),
      input(workspaceId, {issuedBy: {service: "store", actorEmail: "  "}}),
    ]
    for (const body of bad) {
      const reply = await raw("POST", `${API}/credentials`, {body})
      expect({body, status: reply.status, error: reply.json?.error}).toEqual({
        body,
        status: 400,
        error: "invalid_request",
      })
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("an unknown or deleted workspace is refused and nothing is created", async () => {
    const {workspaceId, owner} = await newWorkspace()

    const missing = await raw("POST", `${API}/credentials`, {body: input("ws_missing")})
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})
    const deleted = await raw("POST", `${API}/credentials`, {body: input(workspaceId)})

    expect(missing.status).toBe(404)
    expect(deleted.status).toBe(410)
    expect(deleted.json.error).toBe("workspace_deleted")
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })
})
